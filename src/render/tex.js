// =============================================================================
// render/tex.js  —  Phase 4 渲染器
//
// 把论文中的 LaTeX 片段（混合 prose + 行内/行间数学 + 引用）渲染为可交互 HTML：
//   * 数学用 KaTeX 渲染（注入论文自定义宏）
//   * 带 \label 的行间公式注入 \tag{编号}（与 PDF 一致）
//   * \ref / \eqref / \cite 渲染为可交互 ref-span（data-target / data-kind）
//   * prose 里的 ``''、\emph、\textit、\textup、\path、\cite 等做轻量转换
//
// 用法：
//   import { createRenderer } from './render/tex.js'
//   const render = createRenderer({ macros, numberOf, kindOf, displayOf })
//   container.innerHTML = render(latexFragment)
// =============================================================================

import katex from 'katex';

// ---- 占位符机制：先把 \ref 等抽出，渲染后再替换，避免被 KaTeX/转义破坏 ----
const PH = (i) => `\u0000REF${i}\u0000`;

// 常见数学宏兜底：样例/论文未显式提供 macros 时也能正确渲染（论文实际 macros 覆盖同名项）
const DEFAULT_MACROS = {
  '\\R': '\\mathbb{R}', '\\C': '\\mathbb{C}', '\\N': '\\mathbb{N}', '\\Z': '\\mathbb{Z}', '\\Q': '\\mathbb{Q}',
  '\\norm': '\\left\\lVert #1\\right\\rVert', '\\abs': '\\left|#1\\right|', '\\one': '\\mathbf{1}',
  '\\eps': '\\varepsilon', '\\veps': '\\varepsilon',
  '\\supp': '\\operatorname{supp}', '\\Real': '\\operatorname{Re}', '\\Imag': '\\operatorname{Im}',
};

export function createRenderer(opts) {
  const macros = { ...DEFAULT_MACROS, ...(opts.macros || {}) };
  const numberOf = opts.numberOf || (() => '?');
  const kindOf = opts.kindOf || (() => 'theorem');
  const ownerOf = opts.ownerOf || (() => null);
  // 正文格式：'markdown' 走 Markdown prose（**粗体**、`行内代码`、```代码块```、*斜体*、链接），
  // 其余（latex/text）走原 LaTeX prose。两种模式都仍支持行内/行间数学与 \ref/\cite 引用。
  const isMarkdown = opts.bodyFormat === 'markdown';

  // 把 KaTeX 宏里的 \newcommand 形式转成 katex macros 对象（已是对象，直接用）
  // 但 \ref/\eqref/\cite 不交给 KaTeX，改为占位符再做 HTML 替换。
  function makeRefSpan(cmd, key) {
    const kind = cmd === 'cite' ? 'cite' : kindOf(key);
    const owner = ownerOf(key);
    const num = numberOf(key);
    let text;
    if (cmd === 'eqref') text = `(${num})`;
    else if (cmd === 'cite') text = `[${num}]`;
    else text = `${num}`;
    const cls = `texref texref-${kind}`;
    return `<span class="${cls}" data-target="${escapeAttr(key)}" data-kind="${kind}" data-cmd="${cmd}"${owner ? ` data-owner="${escapeAttr(owner)}"` : ''} tabindex="0">${escapeHtml(text)}</span>`;
  }

  // 主渲染函数
  function render(src) {
    if (!src) return '';
    // 1) 抽出所有 \ref \eqref \cite -> 占位符，记录替换表
    const refs = [];
    let work = src.replace(/\\(ref|eqref|cite)\{([^}]+)\}/g, (_, cmd, body) => {
      // cite 可能多 key
      if (cmd === 'cite') {
        const keys = body.split(',').map((s) => s.trim());
        const spans = keys.map((k) => makeRefSpan('cite', k)).join(', ');
        refs.push(spans);
      } else {
        refs.push(makeRefSpan(cmd, body.trim()));
      }
      return PH(refs.length - 1);
    });

    // 2) 分段：display 数学独立成块；text + inline 数学连续成段落流
    const segs = tokenize(work);
    const inlineStore = [];
    let html = '';
    let paraBuf = '';
    const flushPara = () => {
      if (paraBuf.trim()) html += (isMarkdown ? renderMarkdownProse : renderProse)(paraBuf, inlineStore);
      paraBuf = '';
    };
    for (const seg of segs) {
      if (seg.type === 'text') {
        paraBuf += seg.value;
      } else if (!seg.display) {
        // 行内数学：渲染后塞入占位符，保持文本流连续
        inlineStore.push(renderMath(seg));
        paraBuf += `\u0003M${inlineStore.length - 1}\u0003`;
      } else {
        flushPara();
        html += renderMath(seg);
      }
    }
    flushPara();

    // 3) 占位符回填
    html = html.replace(/\u0000REF(\d+)\u0000/g, (_, i) => refs[+i] || '');
    return html;
  }

  // --- 数学段渲染 ---
  function renderMath(seg) {
    let tex = seg.value;
    const display = seg.display;
    // 提取该段内首个 label，作为 data-label 锚点（供关系箭头定位 —— P4）
    const labelMatch = seg.value.match(/\\label\{([^}]+)\}/);
    const dataLabel = labelMatch ? ` data-label="${escapeAttr(labelMatch[1])}"` : '';
    // 行间环境：若含 \label，注入 \tag 并去掉 \label（KaTeX 不识别 \label）
    // 注意：占位符 \u0000REF.. 在数学里需要保留为可被 KaTeX 接受的文本 -> 用 \htmlClass 包裹后期替换
    // KaTeX 不能直接输出我们的占位符（含 NUL）。策略：把占位符替换为 \text{<PH>}，
    // 渲染后 DOM 里会含该文本，再用字符串替换回 HTML。
    // 为稳妥，这里把 NUL 占位符换成安全 token，再在外层替换。
    tex = normalizeMathEnvs(injectTags(tex));

    try {
      const out = katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
        strict: false,
        trust: true,
        macros,
        fleqn: false,
      });
      return display ? `<div class="math-display"${dataLabel}>${out}</div>` : out;
    } catch (e) {
      return `<code class="math-error">${escapeHtml(seg.value)}</code>`;
    }
  }

  function normalizeMathEnvs(tex) {
    // KaTeX does not reliably support LaTeX's multline environment.  Treat it
    // as a gathered display so exported arXiv papers render instead of falling
    // back to a red raw-TeX error block.
    return tex.replace(/\\begin\{multline\*?\}([\s\S]*?)\\end\{multline\*?\}/g, (_, body) => {
      return `\\begin{gathered}${body}\\end{gathered}`;
    });
  }

  // 把 \begin{equation}\label{k}..\end{equation} 等转换为尾随编号。
  // 不用 KaTeX 的 \tag：它会绝对定位到可视容器右侧，长公式在窄屏横向滚动时会与公式重叠。
  function injectTags(tex) {
    // equation/equation* -> 取出 label 注入尾随文本编号；KaTeX 不支持 equation 环境名，
    // 用 equation* 交给 KaTeX 渲染。这里把 equation 体直接作为单行，附加编号。
    // align / align* 直接交给 KaTeX（其支持 align）。
    // 处理 equation 环境
    tex = tex.replace(/\\begin\{equation\*?\}([\s\S]*?)\\end\{equation\*?\}/g, (full, body) => {
      const { tag, clean } = pullTag(body);
      return `\\begin{equation*}${clean}${tag}\\end{equation*}`;
    });
    // align 环境内的 \label 也转尾随文本编号（逐行）
    tex = tex.replace(/\\begin\{(align\*?|alignat\*?)\}([\s\S]*?)\\end\{\1\}/g, (full, env, body) => {
      const conv = body.replace(/\\label\{([^}]+)\}/g, (_, k) => tagText(k));
      return `\\begin{${env}}${conv}\\end{${env}}`;
    });
    // 裸 \label（在 \[..\] 中）转尾随文本编号
    // 处理放在 renderMath 之前的 \[..\] 已被 tokenizer 标记 display；此处对 seg.value 通用替换
    if (!/\\begin\{/.test(tex)) {
      const { tag, clean } = pullTag(tex);
      tex = clean + tag;
    } else {
      // 清除残留裸 label
      tex = tex.replace(/\\label\{[^}]+\}/g, '');
    }
    return tex;
  }

  function pullTag(body) {
    let tag = '';
    const clean = body.replace(/\\label\{([^}]+)\}/g, (_, k) => {
      tag = tagText(k);
      return '';
    });
    return { tag, clean };
  }

  function tagText(k) {
    return `\\qquad\\text{(${escapeTexText(numberOf(k))})}`;
  }

  // --- prose 段渲染（轻量 LaTeX 文本 -> HTML） ---
  function renderProse(text, inlineStore = []) {
    let s = text;
    // 占位符先用安全 sentinel 保护，避免被转义
    const saved = [];
    s = s.replace(/\u0000REF(\d+)\u0000/g, (m) => {
      saved.push(m);
      return `\u0001${saved.length - 1}\u0001`;
    });

    s = escapeHtml(s);

    // LaTeX 引号 ``...'' 与 `...'
    s = s.replace(/``/g, '\u201c').replace(/''/g, '\u201d');
    s = s.replace(/`/g, '\u2018').replace(/(?<!\w)'/g, '\u2019');

    // \emph{..} \textit{..} \textbf{..} \textup{..} \textsc{..}
    s = s.replace(/\\emph\{([^{}]*)\}/g, '<em>$1</em>');
    s = s.replace(/\\textit\{([^{}]*)\}/g, '<em>$1</em>');
    s = s.replace(/\\textbf\{([^{}]*)\}/g, '<strong>$1</strong>');
    s = s.replace(/\\textup\{([^{}]*)\}/g, '$1');
    s = s.replace(/\\textsc\{([^{}]*)\}/g, '<span class="smallcaps">$1</span>');
    s = s.replace(/\\path\{([^{}]*)\}/g, '<code>$1</code>');
    s = s.replace(/\\texttt\{([^{}]*)\}/g, '<code>$1</code>');

    // 常见转义/空白
    s = s.replace(/\\,/g, '\u2009').replace(/\\ /g, ' ').replace(/~/g, '\u00a0');
    s = s.replace(/\\%/g, '%').replace(/\\&/g, '&amp;').replace(/\\#/g, '#');
    s = s.replace(/\\textup(?=[^a-zA-Z])/g, '');

    // 段落：连续两个换行 -> 段落分隔
    s = s.replace(/\n{2,}/g, '\u0002');
    s = s.replace(/\n/g, ' ');
    const paras = s.split('\u0002').map((p) => p.trim()).filter(Boolean);
    let outHtml = paras.map((p) => `<p>${p}</p>`).join('');

    // 还原 ref 占位符
    outHtml = outHtml.replace(/\u0001(\d+)\u0001/g, (_, i) => saved[+i] || '');
    // 还原 inline math 占位符
    outHtml = outHtml.replace(/\u0003M(\d+)\u0003/g, (_, i) => inlineStore[+i] || '');
    return outHtml;
  }

  // --- Markdown 段渲染（**粗体** *斜体* `行内代码` ```代码块``` [链接](url)） ---
  // 与 renderProse 一致地保护 ref / inline-math 占位符；代码内容先抽出再转义，避免被其它规则破坏。
  function renderMarkdownProse(text, inlineStore = []) {
    let s = text;
    // 1) 保护 render() 注入的 ref 占位符（ REF i  ）
    const saved = [];
    s = s.replace(/ REF(\d+) /g, (m) => { saved.push(m); return ` S${saved.length - 1} `; });
    // 2) 抽出围栏代码块 ```lang\n...```（块级，后续不参与段落/行内规则）
    const blocks = [];
    s = s.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_, code) => {
      blocks.push(`<pre class="md-code"><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
      return ` B${blocks.length - 1} `;
    });
    // 3) 抽出行内代码 `code`
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_, code) => {
      codes.push(`<code class="md-code-inline">${escapeHtml(code)}</code>`);
      return ` C${codes.length - 1} `;
    });
    // 4) 转义其余文本
    s = escapeHtml(s);
    // 5) 行内强调与链接（粗体先于斜体；下划线变体一并支持）
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    // 6) 段落：空行分段；单换行作软换行（空格）
    s = s.replace(/\n{2,}/g, '');
    s = s.replace(/\n/g, ' ');
    const paras = s.split('').map((p) => p.trim()).filter(Boolean);
    let outHtml = paras.map((p) => (/^ B\d+ $/.test(p) ? p : `<p>${p}</p>`)).join('');
    // 7) 还原代码块/行内代码、ref、inline-math 占位符
    outHtml = outHtml.replace(/ B(\d+) /g, (_, i) => blocks[+i] || '');
    outHtml = outHtml.replace(/ C(\d+) /g, (_, i) => codes[+i] || '');
    outHtml = outHtml.replace(/ S(\d+) /g, (_, i) => saved[+i] || '');
    outHtml = outHtml.replace(/M(\d+)/g, (_, i) => inlineStore[+i] || '');
    return outHtml;
  }

  return render;
}

// =============================================================================
// tokenizer：把字符串切成 prose / inline-math / display-math 段
//   支持： \( \)   \[ \]   $...$   \begin{equation|align|...}..\end
// =============================================================================
const DISPLAY_ENVS = ['equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*', 'gather', 'gather*', 'multline', 'multline*'];

function tokenize(src) {
  const segs = [];
  let i = 0;
  let buf = '';
  const pushText = () => {
    if (buf) {
      segs.push({ type: 'text', value: buf });
      buf = '';
    }
  };

  while (i < src.length) {
    // \begin{env}
    if (src.startsWith('\\begin{', i)) {
      const m = /^\\begin\{([a-zA-Z*]+)\}/.exec(src.slice(i));
      if (m && DISPLAY_ENVS.includes(m[1])) {
        const env = m[1];
        const endTag = `\\end{${env}}`;
        const endIdx = src.indexOf(endTag, i);
        if (endIdx !== -1) {
          pushText();
          const full = src.slice(i, endIdx + endTag.length);
          segs.push({ type: 'math', display: true, value: full });
          i = endIdx + endTag.length;
          continue;
        }
      }
    }
    // \[ ... \]
    if (src.startsWith('\\[', i)) {
      const endIdx = src.indexOf('\\]', i + 2);
      if (endIdx !== -1) {
        pushText();
        segs.push({ type: 'math', display: true, value: src.slice(i + 2, endIdx) });
        i = endIdx + 2;
        continue;
      }
    }
    // \( ... \)
    if (src.startsWith('\\(', i)) {
      const endIdx = src.indexOf('\\)', i + 2);
      if (endIdx !== -1) {
        pushText();
        segs.push({ type: 'math', display: false, value: src.slice(i + 2, endIdx) });
        i = endIdx + 2;
        continue;
      }
    }
    // $$ ... $$ （display）
    if (src.startsWith('$$', i)) {
      const endIdx = src.indexOf('$$', i + 2);
      if (endIdx !== -1) {
        pushText();
        segs.push({ type: 'math', display: true, value: src.slice(i + 2, endIdx) });
        i = endIdx + 2;
        continue;
      }
    }
    // $ ... $ （非 $$）
    if (src[i] === '$' && src[i + 1] !== '$') {
      const endIdx = src.indexOf('$', i + 1);
      if (endIdx !== -1) {
        pushText();
        segs.push({ type: 'math', display: false, value: src.slice(i + 1, endIdx) });
        i = endIdx + 1;
        continue;
      }
    }
    buf += src[i];
    i++;
  }
  pushText();
  return segs;
}

// =============================================================================
// 工具
// =============================================================================
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function escapeTexText(s) {
  return String(s).replace(/[\\{}$%&#_^~]/g, (ch) => `\\${ch}`);
}
