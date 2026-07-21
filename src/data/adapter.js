// =============================================================================
// data/adapter.js  —  通用关系结构 → 运行时格式 适配器
//
// 本查看器的运行时（model/graph.js、render、view 各层）历史上耦合于“数学论文”
// 领域：节点有 type=theorem/lemma/..、正文分 statementBody/proofBody、引用用
// LaTeX 的 ref/eqref/cite。为了让任意“带交叉引用的关系结构”都能复用这套可视化，
// 这里定义一份与领域无关的【通用 schema】，并把它编译成运行时所需的内部格式。
//
// 设计原则：
//   * 通用 schema 只描述“实体 / 锚点 / 引用 / 关系”，不假设任何学科。
//   * 运行时内部格式保持不变 → 视图层零改动即可复用。
//   * 论文专用的 tracegraph.json 仍可直接使用（被视为已编译格式）。
//
// 通用 schema 顶层：
//   {
//     "format": "relation-graph@1",
//     "meta":   { title, profile?, macros?, bodyFormat? },
//     "types":  [ { id, label, color?, leaf?, order? }, ... ],
//     "relations": [ { id, label?, numbering?, color? }, ... ],   // 可选
//     "nodes":  [ GenericNode, ... ]
//   }
//
// GenericNode：
//   {
//     "id":      "唯一标识",
//     "type":    "types[].id 之一",
//     "number":  "显示用序号（字符串，可空）",
//     "title":   "标题",
//     "sections":[ { "kind":"statement"|"proof"|任意, "label"?, "body":"正文" } ],
//     "anchors": [ { "id", "kind"?, "number"? } ],   // 可被引用的锚点（含节点自身）
//     "refs":    [ { "id"?, "target", "relation"?, "where"?, "internal"? } ]
//   }
//
// 兼容老字段：若 node 同时给了 statementBody/proofBody/labels/refs(cmd...)，按论文
// 语义直接透传（视为已是运行时格式）。
// =============================================================================

import { DEFAULT_PROFILE, PROFILES, mergeProfile, normalizeTags, memberNode } from './schema.js';

// 判断是否“通用 schema”输入（需要编译），否则按已编译运行时格式透传。
export function isGenericSchema(raw) {
  if (!raw || typeof raw !== 'object') return false;
  // 已编译产物（如 compileProject 输出）带 meta.profileResolved，直接按运行时透传，避免二次编译丢失 documents/documentName
  if (raw.meta?.profileResolved) return false;
  if (typeof raw.format === 'string' && raw.format.startsWith('relation-graph')) return true;
  // 探测：节点用 sections/anchors 而非 statementBody/labels → 通用
  const n = Array.isArray(raw.nodes) ? raw.nodes[0] : null;
  if (n && (Array.isArray(n.sections) || Array.isArray(n.anchors))) return true;
  return false;
}

// 主入口：把任意 schema 规整为运行时 { meta, nodes, edges }。
export function compileGraph(raw) {
  if (!isGenericSchema(raw)) return normalizeRuntime(raw);
  return compileGeneric(raw);
}

// 单个文档的「关系」数：通用 schema 的边是运行时由 refs 派生的（graph.edges 为空），
// 直接读 graph.edges 会显示 0。这里按需编译得到真实派生边数；按 graph 对象缓存避免重复编译。
const _edgeCountCache = new WeakMap();
export function edgeCountOf(graph) {
  if (!graph || typeof graph !== 'object') return 0;
  if (_edgeCountCache.has(graph)) return _edgeCountCache.get(graph);
  let n;
  try { n = compileGraph(graph).edges.length; } catch { n = (graph.edges || []).length; }
  _edgeCountCache.set(graph, n);
  return n;
}

// -----------------------------------------------------------------------------
// 已编译（论文）格式：仅做防御性补全，保证视图层所需字段存在。
// -----------------------------------------------------------------------------
function normalizeRuntime(raw) {
  const profile = mergeProfile(raw?.meta?.profile ? PROFILES[raw.meta.profile] : null);
  const meta = { ...(raw.meta || {}) };
  if (!meta.profileResolved) meta.profileResolved = profile;
  const tags = normalizeTags(raw.tags || meta.tags);
  meta.tags = tags;
  return { meta, nodes: raw.nodes || [], edges: raw.edges || [], tags };
}

// -----------------------------------------------------------------------------
// 通用 schema → 运行时格式
// -----------------------------------------------------------------------------
function compileGeneric(raw) {
  const profile = buildProfileFromGeneric(raw);

  // 1) anchor 全局索引：anchorId -> { nodeId, kind, number }
  const anchorOwner = new Map();
  for (const gn of raw.nodes || []) {
    const anchors = collectAnchors(gn);
    for (const a of anchors) {
      if (!anchorOwner.has(a.id)) anchorOwner.set(a.id, { nodeId: gn.id, kind: a.kind, number: a.number });
    }
  }

  // 2) 节点编译
  const nodes = [];
  for (const gn of raw.nodes || []) {
    const typeDef = profile.typeById[gn.type] || profile.typeById[profile.defaultType];
    const sections = normalizeSections(gn);
    const statementBody = pickSection(sections, profile.statementKinds) || '';
    const proofBody = pickSection(sections, profile.proofKinds) || '';

    const labels = collectAnchors(gn).map((a) => ({
      id: a.id,
      kind: a.kind || (a.id === gn.id ? 'node' : 'sub'),
      number: a.number ?? gn.number ?? '',
    }));
    // 确保节点自身锚点存在（关系箭头“顶部”定位需要）
    if (!labels.some((l) => l.id === gn.id)) {
      labels.unshift({ id: gn.id, kind: 'node', number: gn.number ?? '' });
    }

    const refs = (gn.refs || []).map((r, i) => normalizeRef(r, i, gn.id, anchorOwner, profile));

    nodes.push({
      id: gn.id,
      type: gn.type || profile.defaultType,
      typeLabel: typeDef?.label || gn.type || '',
      number: gn.number ?? '',
      title: gn.title || '',
      statementBody,
      proofBody,
      sections, // 通用多段正文（视图层可选用；旧层用 statement/proofBody）
      labels,
      refs,
    });
  }

  // 3) 由 refs 推导 edges（跨节点；A 被 B 使用： from=被引用方, to=引用方）
  const edges = [];
  const seen = new Set();
  for (const node of nodes) {
    for (const r of node.refs) {
      if (!r.resolved || r.internal) continue;
      const fromNode = r.targetNode;
      const fromLabel = r.target;
      const toNode = node.id;
      const key = `${fromNode}|${fromLabel}|${toNode}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: fromNode, fromLabel, to: toNode, relation: r.relation });
    }
  }

  const meta = {
    title: raw.meta?.title || 'Relation Graph',
    source: raw.meta?.source || '(generic)',
    generatedAt: new Date().toISOString(),
    macros: raw.meta?.macros || {},
    bodyFormat: raw.meta?.bodyFormat || profile.bodyFormat || 'latex',
    profileResolved: profile,
    counts: {
      statements: nodes.filter((n) => !profile.typeById[n.type]?.leaf).length,
      leaf: nodes.filter((n) => profile.typeById[n.type]?.leaf).length,
      edges: edges.length,
      labels: nodes.reduce((s, n) => s + n.labels.length, 0),
    },
  };

  // 图级标签（导入文件 / prompt 生成）：仅保留指向存在节点的成员
  const nodeIds = new Set(nodes.map((n) => n.id));
  const tags = normalizeTags(raw.tags).map((t) => ({ ...t, members: t.members.filter((m) => nodeIds.has(memberNode(m))) }));
  meta.tags = tags;

  return { meta, nodes, edges, tags };
}

// ---- helpers ----

function collectAnchors(gn) {
  const out = [];
  if (Array.isArray(gn.anchors)) {
    for (const a of gn.anchors) {
      if (typeof a === 'string') out.push({ id: a });
      else if (a && a.id) out.push({ id: a.id, kind: a.kind, number: a.number });
    }
  }
  // 兼容老 labels[]
  if (Array.isArray(gn.labels)) {
    for (const l of gn.labels) if (l && l.id) out.push({ id: l.id, kind: l.kind, number: l.number });
  }
  return out;
}

function normalizeSections(gn) {
  if (Array.isArray(gn.sections)) {
    return gn.sections.map((s) => ({ kind: s.kind || 'body', label: s.label || '', body: s.body || '' }));
  }
  // 兼容老 statementBody/proofBody
  const out = [];
  if (gn.statementBody != null) out.push({ kind: 'statement', body: gn.statementBody });
  if (gn.proofBody) out.push({ kind: 'proof', body: gn.proofBody });
  return out;
}

function pickSection(sections, kinds) {
  for (const k of kinds) {
    const s = sections.find((x) => x.kind === k);
    if (s) return s.body;
  }
  return '';
}

function normalizeRef(r, i, ownerNodeId, anchorOwner, profile) {
  const target = r.target;
  const owner = anchorOwner.get(target);
  const targetNode = r.targetNode || owner?.nodeId || null;
  const internal = r.internal ?? (targetNode === ownerNodeId);
  const relation = r.relation || r.cmd || profile.defaultRelation;
  return {
    id: r.id || `r${i}`,
    cmd: relation,            // 旧渲染层读取 cmd
    relation,                 // 通用语义
    target,
    targetNode,
    kind: owner?.kind || r.kind || 'ref',
    where: r.where || 'statement',
    internal,
    resolved: !!targetNode,
  };
}

function buildProfileFromGeneric(raw) {
  let base = DEFAULT_PROFILE;
  if (raw.meta?.profile && PROFILES[raw.meta.profile]) base = PROFILES[raw.meta.profile];
  const types = (raw.types && raw.types.length) ? raw.types : base.types;
  const typeIds = new Set(types.map((t) => t.id));
  const defaultType = typeIds.has(raw.meta?.defaultType) ? raw.meta.defaultType
    : typeIds.has(base.defaultType) ? base.defaultType
      : types[0]?.id;
  return mergeProfile({
    ...base,
    types,
    defaultType,
    relations: raw.relations || base.relations,
    bodyFormat: raw.meta?.bodyFormat || base.bodyFormat,
  });
}
