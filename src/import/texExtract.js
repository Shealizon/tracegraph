const MACROS = {
  '\\C': '\\mathbb{C}',
  '\\R': '\\mathbb{R}',
  '\\norm': '\\left\\lVert #1\\right\\rVert',
  '\\one': '\\mathbf{1}',
};

const THEOREM_ENVS = ['theorem', 'proposition', 'lemma'];
const TYPE_LABEL = { theorem: 'Theorem', proposition: 'Proposition', lemma: 'Lemma' };

export function extractFixedTexGraph(tex, auxText = '', opts = {}) {
  const aux = auxText ? parseAux(auxText) : { labels: new Map(), bib: new Map() };
  const docStart = tex.indexOf('\\begin{document}');
  const docEnd = tex.indexOf('\\end{document}');
  const doc = docStart >= 0 ? tex.slice(docStart, docEnd === -1 ? tex.length : docEnd) : tex;
  const stmtBlocks = findEnvBlocks(doc, THEOREM_ENVS);
  const proofBlocks = findEnvBlocks(doc, ['proof']);
  const nodes = [];
  const ownership = new Map();
  let autoEqNo = 0;
  let autoThmNo = 0;

  for (const sb of stmtBlocks) {
    const head = parseStatementHead(sb.body);
    const nodeId = head.labelKey || `node@${sb.start}`;
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
      labels: [],
      refs: [],
      _stmtRaw: sb.body,
      _proofRaw: proof ? proof.body : '',
    });
  }

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
    addLabel(node.id);
    for (const k of collectLabels(node._stmtRaw)) addLabel(k);
    for (const k of collectLabels(node._proofRaw)) addLabel(k);
  }

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

  const edgeSet = new Set();
  const edges = [];
  let refSeq = 0;
  const addRefs = (node, raw, where) => {
    for (const r of collectRefs(raw)) {
      const targetNode = ownership.get(r.key);
      const kind = r.cmd === 'cite' ? 'cite' : r.cmd === 'eqref' ? 'equation' : aux.labels.get(r.key)?.kind || 'theorem';
      const internal = targetNode === node.id;
      node.refs.push({
        id: `r${refSeq++}`,
        cmd: r.cmd,
        target: r.key,
        targetNode: targetNode || null,
        kind,
        where,
        internal,
        resolved: !!targetNode,
      });
      if (targetNode && !internal) {
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
    delete node._stmtRaw;
    delete node._proofRaw;
  }

  const allNodes = [...nodes, ...bibNodes];
  return {
    meta: {
      source: opts.source || 'imported.tex',
      generatedAt: new Date().toISOString(),
      title: opts.title || inferTitle(tex) || '导入的 TeX 文档',
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
}

function parseAux(text) {
  const map = new Map();
  const re = /\\newlabel\{([^}]+)\}\{\{([^}]*)\}\{[^}]*\}\{([^}]*)\}\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, key, number, title, anchor] = m;
    let kind = 'equation';
    if (anchor.startsWith('theorem.')) kind = 'theorem';
    else if (anchor.startsWith('equation.')) kind = 'equation';
    map.set(key, { number, title, kind });
  }
  const bib = new Map();
  const reb = /\\bibcite\{([^}]+)\}\{([^}]*)\}/g;
  while ((m = reb.exec(text)) !== null) bib.set(m[1], m[2]);
  return { labels: map, bib };
}

function findEnvBlocks(tex, envNames) {
  const blocks = [];
  for (const env of envNames) {
    const open = new RegExp(`\\\\begin\\{${env}\\}`, 'g');
    let m;
    while ((m = open.exec(tex)) !== null) {
      const startTag = m.index;
      const endRe = new RegExp(`\\\\end\\{${env}\\}`, 'g');
      endRe.lastIndex = open.lastIndex;
      const em = endRe.exec(tex);
      if (!em) continue;
      blocks.push({
        env,
        start: startTag,
        end: em.index + em[0].length,
        bodyStart: open.lastIndex,
        bodyEnd: em.index,
        body: tex.slice(open.lastIndex, em.index),
      });
    }
  }
  blocks.sort((a, b) => a.start - b.start);
  return blocks;
}

function parseStatementHead(body) {
  let rest = body;
  let title = '';
  const tm = rest.match(/^\s*\[((?:[^\[\]]|\[[^\]]*\])*)\]/);
  if (tm) {
    title = tm[1].trim();
    rest = rest.slice(tm[0].length);
  }
  let labelKey = null;
  const lm = rest.match(/^\s*\\label\{([^}]+)\}/);
  if (lm) {
    labelKey = lm[1];
    rest = rest.slice(lm[0].length);
  } else {
    const lm2 = rest.match(/\\label\{([^}]+)\}/);
    if (lm2 && lm2.index < 40) labelKey = lm2[1];
  }
  return { title, labelKey, content: rest.replace(/^\s+/, '') };
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
  const re = /\\(ref|eqref|cite)\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const cmd = m[1];
    const keys = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    for (const k of keys) out.push({ cmd, key: k, pos: m.index });
  }
  return out;
}

function inferTitle(tex) {
  return tex.match(/\\title\{([^}]+)\}/)?.[1]?.trim() || '';
}
