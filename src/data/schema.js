// =============================================================================
// data/schema.js  —  通用关系结构的 profile 定义
//
// profile 决定“皮肤”：有哪些节点类型、各自颜色/标签/是否为叶子，以及引用关系的
// 默认编号格式。适配器(adapter.js)据此把通用数据编译成运行时格式，UI 文案与配色
// 也由 profile 提供，从而与具体领域解耦。
//
// 一个 profile 形如：
//   {
//     id, label,
//     bodyFormat: 'latex' | 'markdown' | 'text',
//     defaultType, defaultRelation,
//     statementKinds: ['statement', ...],  // 主体正文 section.kind 候选
//     proofKinds:     ['proof', ...],       // 折叠正文 section.kind 候选
//     types:     [ { id, label, color, leaf?, order? } ],
//     relations: [ { id, label, numbering } ],   // numbering: '(n)'|'[n]'|'n'
//   }
// =============================================================================

// 论文 profile：复刻当前数学论文皮肤（theorem/proposition/lemma/bib）。
const PAPER_PROFILE = {
  id: 'paper',
  label: '学术论文',
  bodyFormat: 'latex',
  defaultType: 'theorem',
  defaultRelation: 'ref',
  statementKinds: ['statement'],
  proofKinds: ['proof'],
  types: [
    { id: 'theorem', label: 'Theorem', color: '#ff9e64', order: 0 },
    { id: 'proposition', label: 'Proposition', color: '#c39bff', order: 1 },
    { id: 'lemma', label: 'Lemma', color: '#7dd3a8', order: 2 },
    { id: 'bib', label: 'Reference', color: '#8a8a98', leaf: true, order: 3 },
  ],
  relations: [
    { id: 'ref', label: '引用', numbering: 'n' },
    { id: 'eqref', label: '公式引用', numbering: '(n)' },
    { id: 'cite', label: '文献引用', numbering: '[n]' },
  ],
};

// 通用 profile：领域无关的默认皮肤（节点 / 子项 / 来源）。
const GENERIC_PROFILE = {
  id: 'generic',
  label: '通用关系图',
  bodyFormat: 'markdown',
  defaultType: 'node',
  defaultRelation: 'ref',
  statementKinds: ['statement', 'summary', 'body', 'main'],
  proofKinds: ['proof', 'detail', 'details', 'note'],
  types: [
    { id: 'primary', label: '主节点', color: '#7c9cff', order: 0 },
    { id: 'node', label: '节点', color: '#7dd3a8', order: 1 },
    { id: 'support', label: '支撑', color: '#c39bff', order: 2 },
    { id: 'source', label: '来源', color: '#8a8a98', leaf: true, order: 3 },
  ],
  relations: [
    { id: 'ref', label: '引用', numbering: 'n' },
    { id: 'cite', label: '来源引用', numbering: '[n]' },
  ],
};

export const PROFILES = {
  paper: PAPER_PROFILE,
  generic: GENERIC_PROFILE,
};

export const DEFAULT_PROFILE = PAPER_PROFILE;

// =============================================================================
// 标签（Tag）：有序（主线/章节/步骤）与无序（喜爱/已看过…）共用同一结构。
// 详见 docs/TAGS-DESIGN.md。
// =============================================================================
// 标签专用调色板：与节点类型配色（橙/淡紫/薄荷/青/粉/金）刻意区分，用更饱和的另一套
export const TAG_COLORS = ['#4f7cff', '#ff4f87', '#1ec8b6', '#a64bf4', '#f5a300', '#ef4d4d'];
export const MAINPATH_TAG_ID = 'mainpath';

// 成员可为「nodeId 字符串（整卡片）」或对象 { node, type:'span'|'pos', … }
export function memberNode(m) { return typeof m === 'string' ? m : (m && m.node) || null; }
export function memberType(m) { return typeof m === 'string' ? 'node' : (m && m.type) || 'node'; }
export function memberKey(m) {
  if (typeof m === 'string') return m;
  if (!m || !m.node) return '';
  if (m.type === 'span') return `${m.node}@span:${m.section || ''}:${m.start}-${m.end}`;
  if (m.type === 'pos') return `${m.node}@pos:${Number(m.x).toFixed(3)},${Number(m.y).toFixed(3)}`;
  return m.node;
}

export function normalizeTag(t, i = 0) {
  const kind = t?.kind === 'ordered' ? 'ordered' : 'unordered';
  const raw = Array.isArray(t?.members) ? t.members.filter((m) => typeof m === 'string' || (m && typeof m === 'object' && m.node)) : [];
  // 按 memberKey 去重，保序
  const seenM = new Set();
  const members = [];
  for (const m of raw) { const k = memberKey(m); if (!k || seenM.has(k)) continue; seenM.add(k); members.push(m); }
  return {
    id: t?.id || (kind === 'ordered' ? MAINPATH_TAG_ID : `tag-${i + 1}`),
    label: typeof t?.label === 'string' ? t.label : '', // 允许空标题（可重名，靠 id 区分）
    kind,
    icon: t?.icon || (kind === 'ordered' ? 'route' : 'tag'),
    color: t?.color || TAG_COLORS[i % TAG_COLORS.length],
    visible: t?.visible !== false,
    // 图中贴片标记文字：有序为序号前缀（如 Step），无序为图标后缀（如 Section）；默认空
    marker: typeof t?.marker === 'string' ? t.marker : '',
    members, // 已按 memberKey 去重保序（成员可为字符串或 span/pos 对象）
  };
}

export function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const out = [];
  tags.forEach((t, i) => {
    const nt = normalizeTag(t, i);
    if (seen.has(nt.id)) return;
    seen.add(nt.id);
    out.push(nt);
  });
  return out;
}

export const isOrderedTag = (t) => t?.kind === 'ordered';

// 把 profile 规整为带索引、可直接消费的形态。
export function mergeProfile(p) {
  const base = p || DEFAULT_PROFILE;
  const types = (base.types || DEFAULT_PROFILE.types).slice().sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  const typeById = Object.fromEntries(types.map((t) => [t.id, t]));
  const relations = base.relations || DEFAULT_PROFILE.relations;
  const relationById = Object.fromEntries(relations.map((r) => [r.id, r]));
  return {
    id: base.id || 'custom',
    label: base.label || base.id || 'custom',
    bodyFormat: base.bodyFormat || 'latex',
    defaultType: base.defaultType || types[0]?.id || 'node',
    defaultRelation: base.defaultRelation || relations[0]?.id || 'ref',
    statementKinds: base.statementKinds || ['statement'],
    proofKinds: base.proofKinds || ['proof'],
    types,
    typeById,
    relations,
    relationById,
  };
}

// 按 numbering 模板格式化引用显示文本。
export function formatRefNumber(numbering, num) {
  if (num == null || num === '') return num ?? '';
  switch (numbering) {
    case '(n)': return `(${num})`;
    case '[n]': return `[${num}]`;
    default: return String(num);
  }
}

export function typeDefOf(modelOrMeta, type) {
  const profile = modelOrMeta?.meta?.profileResolved || modelOrMeta?.profileResolved || modelOrMeta;
  return profile?.typeById?.[type] || null;
}

export function isLeafNode(modelOrMeta, node) {
  const def = typeDefOf(modelOrMeta, node?.type);
  return def ? !!def.leaf : node?.type === 'bib';
}

export function typeColor(modelOrMeta, type) {
  return typeDefOf(modelOrMeta, type)?.color || '#8a8a98';
}

// 项目是否含多篇文献（决定是否展示“所属论文”信息）
export function isMultiDoc(modelOrMeta) {
  const meta = modelOrMeta?.meta || modelOrMeta;
  return ((meta?.documents?.length) || 0) > 1;
}

// 节点所属论文名（仅多篇时返回，单篇返回空串）
export function paperName(modelOrMeta, node) {
  if (!node || !isMultiDoc(modelOrMeta)) return '';
  return node.documentName || '';
}

export function nodeTag(modelOrMeta, node) {
  if (!node) return '';
  if (isLeafNode(modelOrMeta, node)) {
    const num = String(node.number ?? node.id).replace(/^\[+|\]+$/g, ''); // 去掉已有方括号，避免 [[15]]
    return `[${num}]`;
  }
  return `${node.typeLabel || node.type || ''}${node.number ? ' ' + node.number : ''}`.trim() || node.id;
}
