// =============================================================================
// extract.mjs  —  Phase 1 提取器
//
// 读取  ../one-sided-hardy-unique-continuation-verified.tex  (+ 同名 .aux)
// 产出  ../hardy-graph/src/data/tracegraph.json
//
// 对象化格式（"node -- label" 模型）：
//   node   = { id,type,number,title,statementBody,proofBody,labels[],refs[] }
//   label  = { id, kind:'theorem'|'equation', number, display }
//   ref    = { id, target, kind:'theorem'|'equation'|'cite', where:'statement'|'proof', internal }
//   edge   = { from(node), fromLabel, to(node) }     // A.label -> B.refs   (A 被 B 使用)
//
// 设计要点：
//   * 编号优先取自 .aux（与 PDF 完全一致）；若缺失则按 tex 出现顺序回退编号。
//   * label 的归属：定义它的 statement/proof 块所属节点。
//   * 跨节点的 \ref/\eqref 生成 edge；同节点 ref 标 internal=true（只高亮、不连边）。
//   * \cite 生成指向 bib 叶子节点的 ref/edge。
// =============================================================================

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJ = resolve(__dirname, '..');
const ACHIEVE = resolve(PROJ, '..');

const TEX_PATH = resolve(ACHIEVE, 'one-sided-hardy-unique-continuation-verified.tex');
const AUX_PATH = resolve(ACHIEVE, 'one-sided-hardy-unique-continuation-verified.aux');
const OUT_PATH = resolve(PROJ, 'src/data/tracegraph.json');

// --- 论文里的自定义宏（供 KaTeX 运行时使用） ---------------------------------
const MACROS = {
  '\\C': '\\mathbb{C}',
  '\\R': '\\mathbb{R}',
  '\\norm': '\\left\\lVert #1\\right\\rVert',
  '\\one': '\\mathbf{1}',
};

const THEOREM_ENVS = ['theorem', 'proposition', 'lemma'];
const TYPE_LABEL = { theorem: 'Theorem', proposition: 'Proposition', lemma: 'Lemma' };

// =============================================================================
// 1) 解析 .aux —— label -> {number, title}
// =============================================================================
function parseAux(text) {
  const map = new Map();
  // \newlabel{key}{{number}{page}{title}{anchor}{}}
  const re = /\\newlabel\{([^}]+)\}\{\{([^}]*)\}\{[^}]*\}\{([^}]*)\}\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, key, number, title, anchor] = m;
    // anchor 形如 theorem.11 / equation.0.44 —— 用来区分类型
    let kind = 'equation';
    if (anchor.startsWith('theorem.')) kind = 'theorem';
    else if (anchor.startsWith('equation.')) kind = 'equation';
    map.set(key, { number, title, kind });
  }
  // bibcite: \bibcite{key}{n}
  const bib = new Map();
  const reb = /\\bibcite\{([^}]+)\}\{([^}]*)\}/g;
  while ((m = reb.exec(text)) !== null) bib.set(m[1], m[2]);
  return { labels: map, bib };
}

// =============================================================================
// 2) 在 tex 中按顺序定位所有顶层环境块（theorem/lemma/proposition/proof）
//    返回 [{env, start, end, body}]，body 为 \begin..\end 之间的内容。
// =============================================================================
function findEnvBlocks(tex, envNames) {
  const blocks = [];
  for (const env of envNames) {
    const open = new RegExp(`\\\\begin\\{${env}\\}`, 'g');
    let m;
    while ((m = open.exec(tex)) !== null) {
      const startTag = m.index;
      // 找匹配的 \end{env}（这些环境不嵌套同名，安全）
      const endRe = new RegExp(`\\\\end\\{${env}\\}`, 'g');
      endRe.lastIndex = open.lastIndex;
      const em = endRe.exec(tex);
      if (!em) continue;
      const bodyStart = open.lastIndex;
      const bodyEnd = em.index;
      blocks.push({
        env,
        start: startTag,
        end: em.index + em[0].length,
        bodyStart,
        bodyEnd,
        body: tex.slice(bodyStart, bodyEnd),
      });
    }
  }
  blocks.sort((a, b) => a.start - b.start);
  return blocks;
}

// 解析 \begin{theorem}[Title]\label{key} 的可选标题与 label
function parseStatementHead(body) {
  let rest = body;
  let title = '';
  // 可选标题 [..]（允许内部嵌套 [] 一层）
  const tm = rest.match(/^\s*\[((?:[^\[\]]|\[[^\]]*\])*)\]/);
  if (tm) {
    title = tm[1].trim();
    rest = rest.slice(tm[0].length);
  }
  // 紧随的 \label
  let labelKey = null;
  const lm = rest.match(/^\s*\\label\{([^}]+)\}/);
  if (lm) {
    labelKey = lm[1];
    rest = rest.slice(lm[0].length);
  } else {
    // 标题后/标题前也可能有 label，宽松再找一次开头附近
    const lm2 = rest.match(/\\label\{([^}]+)\}/);
    if (lm2 && lm2.index < 40) labelKey = lm2[1];
  }
  return { title, labelKey, content: rest.replace(/^\s+/, '') };
}

// 抽取 body 内所有 \label{...}
function collectLabels(body) {
  const out = [];
  const re = /\\label\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(body)) !== null) out.push(m[1]);
  return out;
}

// 抽取 body 内所有引用：\ref \eqref \cite（含可能的逗号分隔多 key）
function collectRefs(body) {
  const out = [];
  const re = /\\(ref|eqref|cite)\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const cmd = m[1];
    const keys = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    for (const k of keys) out.push({ cmd, key: k, pos: m.index });
  }
  return out;
}

// =============================================================================
// 3) 主流程
// =============================================================================
function main() {
  const tex = readFileSync(TEX_PATH, 'utf8');
  const aux = existsSync(AUX_PATH) ? parseAux(readFileSync(AUX_PATH, 'utf8')) : { labels: new Map(), bib: new Map() };

  // -- 文档主体（\begin{document}..\end{document}）
  const docStart = tex.indexOf('\\begin{document}');
  const docEnd = tex.indexOf('\\end{document}');
  const doc = tex.slice(docStart, docEnd === -1 ? tex.length : docEnd);

  const stmtBlocks = findEnvBlocks(doc, THEOREM_ENVS);
  const proofBlocks = findEnvBlocks(doc, ['proof']);

  // -- 把每个 proof 配对到它前面最近的 statement
  const nodes = [];
  const ownership = new Map(); // labelKey -> nodeId
  let autoEqNo = 0;
  let autoThmNo = 0;

  for (const sb of stmtBlocks) {
    const head = parseStatementHead(sb.body);
    const nodeId = head.labelKey || `node@${sb.start}`;
    // 找紧跟其后的 proof（start 在 statement.end 之后、且在下一个 statement 之前）
    const nextStmt = stmtBlocks.find((x) => x.start > sb.start);
    const nextStart = nextStmt ? nextStmt.start : Infinity;
    const proof = proofBlocks.find((p) => p.start >= sb.end && p.start < nextStart);

    const auxInfo = aux.labels.get(nodeId);
    const number = auxInfo ? auxInfo.number : String(++autoThmNo);

    nodes.push({
      id: nodeId,
      type: sb.env,
      typeLabel: TYPE_LABEL[sb.env] || sb.env,
      number,
      title: head.title,
      statementBody: head.content.trim(),
      proofBody: proof ? proof.body.trim() : '',
      labels: [], // 稍后填
      refs: [], // 稍后填
      _stmtRaw: sb.body,
      _proofRaw: proof ? proof.body : '',
    });
  }

  // -- 标签归属：节点自身 theorem label + statement/proof 内所有 equation label
  for (const node of nodes) {
    const seen = new Set();
    const addLabel = (key) => {
      if (seen.has(key)) return;
      seen.add(key);
      ownership.set(key, node.id);
      const info = aux.labels.get(key);
      const kind = key === node.id ? 'theorem' : info ? info.kind : key.startsWith('thm:') || key.startsWith('lem:') || key.startsWith('prop:') ? 'theorem' : 'equation';
      let number = info ? info.number : null;
      if (number == null) number = kind === 'theorem' ? node.number : String(++autoEqNo);
      node.labels.push({ id: key, kind, number });
    };
    // 节点本身
    addLabel(node.id);
    // statement 与 proof 内的所有 label
    for (const k of collectLabels(node._stmtRaw)) addLabel(k);
    for (const k of collectLabels(node._proofRaw)) addLabel(k);
  }

  // -- bib 叶子节点
  const bibNodes = [];
  for (const [key, n] of aux.bib.entries()) {
    bibNodes.push({
      id: key,
      type: 'bib',
      typeLabel: 'Reference',
      number: n,
      title: key,
      statementBody: '',
      proofBody: '',
      labels: [{ id: key, kind: 'cite', number: n }],
      refs: [],
    });
    ownership.set(key, key);
  }

  // -- 引用收集 + 连边
  const edgeSet = new Set();
  const edges = [];
  let refSeq = 0;
  const addRefs = (node, raw, where) => {
    for (const r of collectRefs(raw)) {
      const targetNode = ownership.get(r.key);
      const kind = r.cmd === 'cite' ? 'cite' : r.cmd === 'eqref' ? 'equation' : aux.labels.get(r.key)?.kind || 'theorem';
      const internal = targetNode === node.id;
      const refId = `r${refSeq++}`;
      node.refs.push({
        id: refId,
        cmd: r.cmd,
        target: r.key,
        targetNode: targetNode || null,
        kind,
        where,
        internal,
        resolved: !!targetNode,
      });
      if (targetNode && !internal) {
        // edge: target(label) -> node(refs)
        const ekey = `${targetNode}::${r.key}->${node.id}`;
        if (!edgeSet.has(ekey)) {
          edgeSet.add(ekey);
          edges.push({ from: targetNode, fromLabel: r.key, to: node.id });
        }
      }
    }
  };
  for (const node of nodes) {
    addRefs(node, node._stmtRaw, 'statement');
    addRefs(node, node._proofRaw, 'proof');
  }

  // -- 清理内部字段
  for (const node of nodes) {
    delete node._stmtRaw;
    delete node._proofRaw;
  }

  const allNodes = [...nodes, ...bibNodes];

  const payload = {
    meta: {
      source: 'one-sided-hardy-unique-continuation-verified.tex',
      generatedAt: new Date().toISOString(),
      title: 'A Fully Verified Proof of Sharp One-Sided Hardy Uniqueness',
      macros: MACROS,
      counts: {
        statements: nodes.length,
        bib: bibNodes.length,
        edges: edges.length,
        labels: [...ownership.keys()].length,
      },
    },
    nodes: allNodes,
    edges,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), 'utf8');

  // -- 控制台诊断
  console.log(`[extract] statements=${nodes.length} bib=${bibNodes.length} edges=${edges.length}`);
  const unresolved = [];
  for (const node of allNodes) for (const r of node.refs) if (!r.resolved) unresolved.push(`${node.id} -> \\${r.cmd}{${r.target}}`);
  if (unresolved.length) {
    console.warn(`[extract] WARNING unresolved refs (${unresolved.length}):`);
    for (const u of unresolved) console.warn('   ', u);
  } else {
    console.log('[extract] all refs resolved.');
  }
  console.log(`[extract] wrote ${OUT_PATH}`);
}

main();
