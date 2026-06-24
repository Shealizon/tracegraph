// =============================================================================
// import/texGeneric.js  —  通用 TeX 本地导入（自动识别，无需固定格式 / 无外部依赖）
//
// 不再要求论文是「固定格式」：
//   * 通过 \newtheorem{env}[..]{Printed Name} 自动发现自定义定理类环境及其显示名；
//   * 再把正文中实际出现的常见环境（corollary/definition/... ）一并纳入；
//   * 复用 extractFixedTexGraph 的本地解析（label/ref/cite/编号），全部在浏览器执行。
// =============================================================================
import { extractFixedTexGraph } from './texExtract.js';

const COMMON_ENVS = {
  theorem: 'Theorem',
  proposition: 'Proposition',
  lemma: 'Lemma',
  corollary: 'Corollary',
  definition: 'Definition',
  claim: 'Claim',
  conjecture: 'Conjecture',
  remark: 'Remark',
  observation: 'Observation',
  example: 'Example',
};

// 解析 \newtheorem{env}[counter]{Printed}[parent] —— 收集自定义环境名与显示名
export function detectTheoremEnvs(tex) {
  const labels = {};
  const re = /\\newtheorem\*?\s*\{([^}]+)\}(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(tex)) !== null) labels[m[1].trim()] = m[2].trim();
  return labels;
}

export function extractGenericTexGraph(tex, auxText = '', opts = {}) {
  const declared = detectTheoremEnvs(tex);
  const envSet = new Set(Object.keys(declared));
  // 正文中实际出现的常见环境也纳入（即便没有 \newtheorem 声明）
  for (const env of Object.keys(COMMON_ENVS)) {
    if (new RegExp(`\\\\begin\\{${env}\\}`).test(tex)) envSet.add(env);
  }
  // 兜底：什么都没识别到时退回最常见三类
  if (envSet.size === 0) ['theorem', 'proposition', 'lemma'].forEach((e) => envSet.add(e));

  const envs = [...envSet];
  const typeLabels = {};
  for (const env of envs) typeLabels[env] = declared[env] || COMMON_ENVS[env] || cap(env);

  const graph = extractFixedTexGraph(tex, auxText, { ...opts, envs, typeLabels });
  graph.meta.macros = { ...(graph.meta.macros || {}), ...detectNewcommandMacros(tex) };
  return enrichWithExternalEquations(graph, tex);
}

function cap(s) { s = String(s || ''); return s ? s[0].toUpperCase() + s.slice(1) : s; }

function detectNewcommandMacros(tex) {
  const macros = {};
  const re = /\\(?:re)?newcommand\s*\{(\\[a-zA-Z]+)\}(?:\[(\d+)\])?\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
  let m;
  while ((m = re.exec(tex)) !== null) {
    const [, name, argc, body] = m;
    macros[name] = argc ? body.replace(/#/g, '#') : body;
  }
  return macros;
}

function enrichWithExternalEquations(graph, tex) {
  const owned = new Set();
  for (const n of graph.nodes || []) for (const l of n.labels || []) owned.add(l.id);
  const numberOf = inferEquationNumbers(tex);
  const added = [];
  let auto = 0;

  for (const block of findMathBlocks(tex)) {
    const labels = collectLabels(block.body).filter((id) => !owned.has(id));
    if (!labels.length) continue;
    const nodeId = labels[0];
    const seen = new Set();
    const nodeLabels = [];
    for (const id of labels) {
      if (seen.has(id)) continue;
      seen.add(id);
      owned.add(id);
      nodeLabels.push({ id, kind: 'equation', number: numberOf.get(id) || String(++auto) });
    }
    added.push({
      id: nodeId,
      type: 'equation',
      typeLabel: 'Equation',
      number: nodeLabels[0]?.number || '',
      title: '',
      statementBody: block.raw.trim(),
      proofBody: '',
      labels: nodeLabels,
      refs: collectRefs(block.raw).map((r, i) => ({
        id: `eq${added.length}-${i}`,
        cmd: r.cmd,
        target: r.key,
        targetNode: null,
        kind: r.cmd === 'cite' ? 'cite' : r.cmd === 'eqref' ? 'equation' : 'theorem',
        where: 'statement',
        internal: false,
        resolved: false,
      })),
    });
  }

  if (added.length) graph.nodes.push(...added);
  resolveGraphRefs(graph);
  graph.meta.counts = {
    ...(graph.meta.counts || {}),
    statements: (graph.nodes || []).filter((n) => n.type !== 'bib').length,
    bib: (graph.nodes || []).filter((n) => n.type === 'bib').length,
    edges: (graph.edges || []).length,
    labels: (graph.nodes || []).reduce((sum, n) => sum + (n.labels?.length || 0), 0),
  };
  return graph;
}

function resolveGraphRefs(graph) {
  const ownership = new Map();
  for (const node of graph.nodes || []) {
    for (const label of node.labels || []) if (!ownership.has(label.id)) ownership.set(label.id, { node, label });
  }
  graph.edges = [];
  const edgeSet = new Set();
  let seq = 0;
  for (const node of graph.nodes || []) {
    for (const ref of node.refs || []) {
      const owner = ownership.get(ref.target);
      if (!owner) continue;
      ref.targetNode = owner.node.id;
      ref.resolved = true;
      ref.internal = owner.node.id === node.id;
      if (ref.internal) continue;
      const key = `${owner.node.id}::${ref.target}->${node.id}`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      graph.edges.push({ from: owner.node.id, fromLabel: ref.target, to: node.id });
    }
    for (const ref of node.refs || []) if (!ref.id) ref.id = `r${seq++}`;
  }
}

function inferEquationNumbers(tex) {
  const map = new Map();
  const sectioned = /\\numberwithin\{equation\}\{section\}/.test(tex);
  const doc = documentBody(tex);
  const events = [];
  const secRe = /\\begin\{section\}\{[^}]*\}|\\section\*?\{[^}]*\}/g;
  let m;
  while ((m = secRe.exec(doc)) !== null) events.push({ kind: 'section', start: m.index });
  for (const block of findMathBlocks(doc)) events.push({ kind: 'math', start: block.start, block });
  events.sort((a, b) => a.start - b.start);

  let section = 0;
  let equation = 0;
  let global = 0;
  for (const ev of events) {
    if (ev.kind === 'section') {
      section += 1;
      equation = 0;
      continue;
    }
    if (ev.block.starred) continue;
    const labels = collectLabels(ev.block.body);
    equation += 1;
    global += 1;
    const number = sectioned ? `${Math.max(1, section)}.${equation}` : String(global);
    for (const id of labels) map.set(id, number);
  }
  return map;
}

function documentBody(tex) {
  const docStart = tex.indexOf('\\begin{document}');
  const docEnd = tex.indexOf('\\end{document}');
  return docStart >= 0 ? tex.slice(docStart, docEnd === -1 ? tex.length : docEnd) : tex;
}

function findMathBlocks(tex) {
  const envs = ['equation', 'align', 'alignat', 'gather', 'multline'];
  const blocks = [];
  for (const env of envs) {
    const open = new RegExp(`\\\\begin\\{${env}(\\*)?\\}`, 'g');
    let m;
    while ((m = open.exec(tex)) !== null) {
      const fullEnv = `${env}${m[1] || ''}`;
      const endName = fullEnv.replace('*', '\\*');
      const endRe = new RegExp(`\\\\end\\{${endName}\\}`, 'g');
      endRe.lastIndex = open.lastIndex;
      const em = endRe.exec(tex);
      if (!em) continue;
      blocks.push({
        env: fullEnv,
        starred: !!m[1],
        start: m.index,
        end: em.index + em[0].length,
        body: tex.slice(open.lastIndex, em.index),
        raw: tex.slice(m.index, em.index + em[0].length),
      });
    }
  }
  blocks.sort((a, b) => a.start - b.start);
  return blocks;
}

function collectLabels(body) {
  const out = [];
  const re = /\\label\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(body)) !== null) out.push(m[1]);
  return out;
}

function collectRefs(body) {
  const out = [];
  const re = /\\(ref|eqref|cite)(?:\[[^\]]*\])?\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const cmd = m[1];
    for (const key of m[2].split(',').map((s) => s.trim()).filter(Boolean)) out.push({ cmd, key });
  }
  return out;
}
