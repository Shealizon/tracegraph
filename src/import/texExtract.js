const MACROS = {
  '\\C': '\\mathbb{C}',
  '\\R': '\\mathbb{R}',
  '\\norm': '\\left\\lVert #1\\right\\rVert',
  '\\one': '\\mathbf{1}',
};

const THEOREM_ENVS = ['theorem', 'proposition', 'lemma'];
const TYPE_LABEL = { theorem: 'Theorem', proposition: 'Proposition', lemma: 'Lemma' };

export function extractFixedTexGraph(tex, auxText = '', opts = {}) {
  const envs = opts.envs && opts.envs.length ? opts.envs : THEOREM_ENVS;
  const typeLabels = opts.typeLabels || TYPE_LABEL;
  const aux = auxText ? parseAux(auxText) : { labels: new Map(), bib: new Map() };
  const texBib = parseBibliography(tex);
  const equationLabels = buildEquationLabelInfo(tex, aux);
  const docStart = tex.indexOf('\\begin{document}');
  const docEnd = tex.indexOf('\\end{document}');
  const doc = docStart >= 0 ? tex.slice(docStart, docEnd === -1 ? tex.length : docEnd) : tex;
  const stmtBlocks = findEnvBlocks(doc, envs);
  const proofBlocks = findEnvBlocks(doc, ['proof']);
  const nodes = [];
  const ownership = new Map();
  let autoEqNo = 0;
  let autoThmNo = 0;

  for (const sb of stmtBlocks) {
    const head = parseStatementHead(sb.body);
    const nodeId = head.labelKey || `node@${sb.start}`;
    const auxInfo = aux.labels.get(nodeId);
    const number = auxInfo ? auxInfo.number : String(++autoThmNo);
    nodes.push({
      id: nodeId,
      type: sb.env,
      typeLabel: typeLabels[sb.env] || cap(sb.env),
      number,
      title: head.title,
      statementBody: head.content.trim(),
      proofBody: '',
      labels: [],
      refs: [],
      _stmtStart: sb.start,
      _stmtEnd: sb.end,
      _stmtRaw: sb.body,
      _proofRaw: '',
    });
  }

  attachProofBlocks(nodes, stmtBlocks, proofBlocks);

  for (const node of nodes) {
    const seen = new Set();
    const addLabel = (key) => {
      if (seen.has(key)) return;
      seen.add(key);
      ownership.set(key, node.id);
      const info = aux.labels.get(key) || equationLabels.get(key);
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
  const bibEntries = new Map([...texBib.entries(), ...aux.bib.entries()]);
  for (const [key, entry] of bibEntries.entries()) {
    const n = typeof entry === 'object' ? entry.number : entry;
    bibNodes.push({
      id: key,
      type: 'bib',
      typeLabel: 'Reference',
      number: n,
      title: typeof entry === 'object' ? entry.title : key,
      statementBody: typeof entry === 'object' ? entry.body : '',
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
    delete node._stmtStart;
    delete node._stmtEnd;
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

function attachProofBlocks(nodes, stmtBlocks, proofBlocks) {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const usedProofs = new Set();

  for (const proof of proofBlocks) {
    const head = parseProofHead(proof.body);
    const targets = collectRefs(head.title)
      .map((r) => r.key)
      .filter((id, i, arr) => nodeById.has(id) && arr.indexOf(id) === i);
    if (!targets.length) continue;
    for (const id of targets) appendProof(nodeById.get(id), head.content);
    usedProofs.add(proof);
  }

  for (let i = 0; i < stmtBlocks.length; i++) {
    const sb = stmtBlocks[i];
    const node = nodes[i];
    const nextStart = stmtBlocks[i + 1]?.start ?? Infinity;
    const proof = proofBlocks.find((p) => !usedProofs.has(p) && p.start >= sb.end && p.start < nextStart);
    if (!proof) continue;
    appendProof(node, parseProofHead(proof.body).content);
    usedProofs.add(proof);
  }
}

function appendProof(node, body) {
  if (!node || !body.trim()) return;
  node.proofBody = node.proofBody ? `${node.proofBody.trim()}\n\n${body.trim()}` : body.trim();
  node._proofRaw = node._proofRaw ? `${node._proofRaw}\n\n${body}` : body;
}

function parseProofHead(body) {
  let rest = body;
  let title = '';
  const tm = rest.match(/^\s*\[((?:[^\[\]]|\[[^\]]*\])*)\]/);
  if (tm) {
    title = tm[1].trim();
    rest = rest.slice(tm[0].length);
  }
  return { title, content: rest.replace(/^\s+/, '') };
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
  const re = /\\(ref|eqref|cite)(?:\[[^\]]*\])?\{([^}]+)\}/g;
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

function cap(s) { s = String(s || ''); return s ? s[0].toUpperCase() + s.slice(1) : s; }

function parseBibliography(tex) {
  const out = new Map();
  const bm = tex.match(/\\begin\{thebibliography\}(?:\{[^}]*\})?([\s\S]*?)\\end\{thebibliography\}/);
  if (!bm) return out;
  const body = bm[1];
  const re = /\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}/g;
  const items = [];
  let m;
  while ((m = re.exec(body)) !== null) items.push({ key: m[1], start: m.index, bodyStart: re.lastIndex });
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const end = items[i + 1]?.start ?? body.length;
    const raw = body.slice(item.bodyStart, end).trim();
    out.set(item.key, {
      number: String(i + 1),
      title: bibliographyTitle(raw, item.key),
      body: raw,
    });
  }
  return out;
}

function bibliographyTitle(raw, fallback) {
  const text = raw
    .replace(/\\emph\{([^{}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?(?:\{([^{}]*)\})?/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 140) || fallback;
}

function buildEquationLabelInfo(tex, aux) {
  const info = new Map();
  const sectioned = /\\numberwithin\{equation\}\{section\}/.test(tex);
  const docStart = tex.indexOf('\\begin{document}');
  const docEnd = tex.indexOf('\\end{document}');
  const doc = docStart >= 0 ? tex.slice(docStart, docEnd === -1 ? tex.length : docEnd) : tex;
  const events = [];
  const secRe = /\\begin\{section\}\{[^}]*\}|\\section\*?\{[^}]*\}/g;
  let m;
  while ((m = secRe.exec(doc)) !== null) events.push({ kind: 'section', start: m.index });
  for (const block of findMathBlocks(doc)) events.push({ kind: 'math', start: block.start, block });
  events.sort((a, b) => a.start - b.start);

  let section = 0;
  let equation = 0;
  let globalEquation = 0;
  for (const ev of events) {
    if (ev.kind === 'section') {
      section += 1;
      equation = 0;
      continue;
    }
    const block = ev.block;
    const labels = collectLabels(block.body);
    if (!labels.length) continue;
    let number = null;
    if (!block.starred) {
      equation += 1;
      globalEquation += 1;
      number = sectioned ? `${Math.max(1, section)}.${equation}` : String(globalEquation);
    }
    for (const key of labels) {
      if (aux.labels.has(key)) continue;
      info.set(key, { number, title: '', kind: 'equation' });
    }
  }
  return info;
}

function findMathBlocks(tex) {
  const envs = ['equation', 'align', 'alignat', 'gather', 'multline'];
  const blocks = [];
  for (const env of envs) {
    const open = new RegExp(`\\\\begin\\{${env}(\\*)?\\}`, 'g');
    let m;
    while ((m = open.exec(tex)) !== null) {
      const fullEnv = `${env}${m[1] || ''}`;
      const endRe = new RegExp(`\\\\end\\{${fullEnv.replace('*', '\\\\*')}\\}`, 'g');
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
