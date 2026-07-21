// 端到端 KaTeX 渲染冒烟测试（复用真实 tokenizer 逻辑的等价实现）
import katex from 'katex';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(resolve(__dirname, '../src/data/tracegraph.json'), 'utf8'));

const macros = { '\\C': '\\mathbb{C}', '\\R': '\\mathbb{R}', '\\norm': '\\left\\lVert #1\\right\\rVert', '\\one': '\\mathbf{1}' };
const numMap = new Map();
for (const n of raw.nodes) for (const l of n.labels) numMap.set(l.id, l.number);
const numberOf = (k) => numMap.get(k) ?? '?';

const DISPLAY_ENVS = ['equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*', 'gather', 'gather*', 'multline', 'multline*'];
function tokenize(src) {
  const segs = [];
  let i = 0, buf = '';
  const pt = () => { if (buf) { segs.push({ type: 'text', value: buf }); buf = ''; } };
  while (i < src.length) {
    if (src.startsWith('\\begin{', i)) {
      const m = /^\\begin\{([a-zA-Z*]+)\}/.exec(src.slice(i));
      if (m && DISPLAY_ENVS.includes(m[1])) {
        const end = `\\end{${m[1]}}`;
        const e = src.indexOf(end, i);
        if (e !== -1) { pt(); segs.push({ type: 'math', display: true, value: src.slice(i, e + end.length) }); i = e + end.length; continue; }
      }
    }
    if (src.startsWith('\\[', i)) { const e = src.indexOf('\\]', i + 2); if (e !== -1) { pt(); segs.push({ type: 'math', display: true, value: src.slice(i + 2, e) }); i = e + 2; continue; } }
    if (src.startsWith('\\(', i)) { const e = src.indexOf('\\)', i + 2); if (e !== -1) { pt(); segs.push({ type: 'math', display: false, value: src.slice(i + 2, e) }); i = e + 2; continue; } }
    if (src[i] === '$' && src[i + 1] !== '$') { const e = src.indexOf('$', i + 1); if (e !== -1) { pt(); segs.push({ type: 'math', display: false, value: src.slice(i + 1, e) }); i = e + 1; continue; } }
    buf += src[i]; i++;
  }
  pt();
  return segs;
}
function injectTags(tex) {
  tex = tex.replace(/\\begin\{equation\*?\}([\s\S]*?)\\end\{equation\*?\}/g, (f, b) => {
    let tag = '';
    const c = b.replace(/\\label\{([^}]+)\}/g, (_, k) => { tag = `\\tag{${numberOf(k)}}`; return ''; });
    return `\\begin{equation*}${c}${tag}\\end{equation*}`;
  });
  tex = tex.replace(/\\begin\{(align\*?|alignat\*?)\}([\s\S]*?)\\end\{\1\}/g, (f, e, b) =>
    `\\begin{${e}}${b.replace(/\\label\{([^}]+)\}/g, (_, k) => `\\tag{${numberOf(k)}}`)}\\end{${e}}`);
  if (!/\\begin\{/.test(tex)) tex = tex.replace(/\\label\{([^}]+)\}/g, (_, k) => `\\tag{${numberOf(k)}}`);
  else tex = tex.replace(/\\label\{[^}]+\}/g, '');
  return tex;
}

let mathSegs = 0, errors = 0, textSegs = 0;
for (const n of raw.nodes) {
  for (const body of [n.statementBody, n.proofBody]) {
    if (!body) continue;
    const work = body.replace(/\\(ref|eqref|cite)\{[^}]+\}/g, 'X'); // refs 在 prose，置换占位
    for (const seg of tokenize(work)) {
      if (seg.type === 'text') { textSegs++; continue; }
      mathSegs++;
      try {
        katex.renderToString(injectTags(seg.value), { displayMode: seg.display, throwOnError: true, strict: false, trust: true, macros });
      } catch (e) {
        errors++;
        if (errors <= 20) console.log(`ERR [${n.id}]: ${e.message.split('\n')[0]} :: ${seg.value.slice(0, 70).replace(/\s+/g, ' ')}`);
      }
    }
  }
}
console.log(`\ntext segs=${textSegs}  math segs=${mathSegs}  errors=${errors}`);
