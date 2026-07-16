import DOMPurify from 'dompurify';
import { marked } from 'marked';
import renderMathInElement from 'katex/contrib/auto-render';
import { parseGraphReferenceHref } from '../data/graphReference.js';
import { parseFileFragmentReferenceHref } from '../data/fileReference.js';

marked.setOptions({ gfm: true, breaks: true });

export function renderMarkdownInto(element, markdown, {
  macros = {}, sources = [], graphLabels = null, onGraphNavigate = null,
  onGraphHover = null, onGraphLeave = null, onGraphReference = null,
  onFileFragmentReference = null, onWorkspaceFile = null,
} = {}) {
  // CommonMark treats backslashes before punctuation as escapes.  Passing the
  // model output straight through marked would therefore turn `\[...\]` into
  // `[...]`, and can also damage commands such as `\,` inside a formula.
  // Replace complete math spans with inert text tokens until Markdown parsing
  // and sanitizing are finished, then restore them for KaTeX auto-rendering.
  const protectedMath = protectMarkdownMath(normalizeCjkStrong(String(markdown || '')));
  const raw = marked.parse(protectedMath.markdown);
  element.innerHTML = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  restoreMarkdownMath(element, protectedMath.expressions);

  for (const anchor of element.querySelectorAll('a[href]')) {
    const fileReference = parseFileFragmentReferenceHref(anchor.getAttribute('href'));
    const reference = parseGraphReferenceHref(anchor.getAttribute('href'));
    if (fileReference) {
      anchor.removeAttribute('target');
      anchor.removeAttribute('rel');
      anchor.classList.add('file-fragment-reference');
      anchor.addEventListener('click', (event) => {
        event.preventDefault();
        onFileFragmentReference?.(fileReference, anchor);
      });
    } else if (reference) {
      anchor.removeAttribute('target');
      anchor.removeAttribute('rel');
      anchor.classList.add('graph-content-reference');
      anchor.addEventListener('click', (event) => {
        event.preventDefault();
        onGraphReference?.(reference, anchor);
      });
    } else if (onWorkspaceFile && workspacePathFromHref(anchor.getAttribute('href'))) {
      const filePath = workspacePathFromHref(anchor.getAttribute('href'));
      anchor.removeAttribute('href');
      anchor.removeAttribute('target');
      anchor.removeAttribute('rel');
      anchor.dataset.workspacePath = filePath;
      anchor.setAttribute('role', 'link');
      anchor.tabIndex = 0;
      anchor.classList.add('workspace-file-reference');
      const openWorkspaceFile = (event) => {
        event.preventDefault();
        onWorkspaceFile(filePath, anchor);
      };
      anchor.addEventListener('click', openWorkspaceFile);
      anchor.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') openWorkspaceFile(event);
      });
    } else {
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
    }
  }

  renderMathInElement(element, {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '\\[', right: '\\]', display: true },
      { left: '\\(', right: '\\)', display: false },
      { left: '$', right: '$', display: false },
    ],
    ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
    throwOnError: false,
    strict: false,
    macros,
  });

  injectCitations(element, sources);
  injectGraphReferences(element, graphLabels, { onNavigate: onGraphNavigate, onHover: onGraphHover, onLeave: onGraphLeave });
}

export function workspacePathFromHref(value) {
  const href = String(value || '').trim();
  if (!href || href.startsWith('#') || href.startsWith('/') || href.startsWith('//')
    || /^[a-z][a-z0-9+.-]*:/i.test(href)) return '';
  let decoded;
  try { decoded = decodeURIComponent(href.split(/[?#]/, 1)[0]); } catch { return ''; }
  const parts = decoded.replaceAll('\\', '/').split('/').filter((part) => part && part !== '.');
  if (!parts.length || parts.some((part) => part === '..' || part.includes('\0'))) return '';
  return parts.join('/');
}

const MATH_TOKEN_PREFIX = 'AIPANELMATHTOKEN';
const MATH_TOKEN_SUFFIX = 'ENDTOKEN';

/**
 * CommonMark's Unicode flanking rules reject strong delimiters when CJK text
 * ends in full-width punctuation and is immediately followed by another CJK
 * word character. Convert only those known-bad pairs to sanitized HTML while
 * leaving code spans and fenced code untouched.
 */
export function normalizeCjkStrong(source) {
  const input = String(source || '');
  let output = '';
  let cursor = 0;
  while (cursor < input.length) {
    const fence = readCodeFence(input, cursor);
    if (fence) { output += fence.value; cursor = fence.end; continue; }
    const code = readInlineCode(input, cursor);
    if (code) { output += code.value; cursor = code.end; continue; }
    if (!input.startsWith('**', cursor) || input[cursor - 1] === '*') {
      output += input[cursor++];
      continue;
    }
    const close = input.indexOf('**', cursor + 2);
    if (close < 0 || input[close + 2] === '*') {
      output += input[cursor++];
      continue;
    }
    const inner = input.slice(cursor + 2, close);
    const before = input[cursor - 1] || '';
    const after = input[close + 2] || '';
    const first = inner[0] || '';
    const last = inner.at(-1) || '';
    const hasCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(inner);
    const blockedOpener = isUnicodePunctuation(first) && isUnicodeWord(before);
    const blockedCloser = isUnicodePunctuation(last) && isUnicodeWord(after);
    if (hasCjk && (blockedOpener || blockedCloser)) {
      output += `<strong>${inner}</strong>`;
      cursor = close + 2;
      continue;
    }
    output += input.slice(cursor, close + 2);
    cursor = close + 2;
  }
  return output;
}

function isUnicodePunctuation(value) { return !!value && /[\p{P}\p{S}]/u.test(value); }
function isUnicodeWord(value) { return !!value && !/[\s\p{P}\p{S}]/u.test(value); }

/**
 * Protect TeX math from Markdown's backslash escaping while leaving fenced and
 * inline code untouched. Exported to make the parser independently testable.
 */
export function protectMarkdownMath(source) {
  const input = String(source || '');
  const expressions = [];
  let markdown = '';
  let cursor = 0;

  while (cursor < input.length) {
    const fence = readCodeFence(input, cursor);
    if (fence) {
      markdown += fence.value;
      cursor = fence.end;
      continue;
    }

    const code = readInlineCode(input, cursor);
    if (code) {
      markdown += code.value;
      cursor = code.end;
      continue;
    }

    const math = readMathSpan(input, cursor);
    if (math) {
      const index = expressions.push(math.value) - 1;
      markdown += `${MATH_TOKEN_PREFIX}${index}${MATH_TOKEN_SUFFIX}`;
      cursor = math.end;
      continue;
    }

    markdown += input[cursor];
    cursor += 1;
  }

  return { markdown, expressions };
}

function restoreMarkdownMath(root, expressions) {
  if (!expressions.length) return;
  const tokenPattern = new RegExp(`${MATH_TOKEN_PREFIX}(\\d+)${MATH_TOKEN_SUFFIX}`, 'g');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    if (walker.currentNode.nodeValue?.includes(MATH_TOKEN_PREFIX)) nodes.push(walker.currentNode);
  }
  for (const node of nodes) {
    node.nodeValue = node.nodeValue.replace(tokenPattern, (_, index) => expressions[Number(index)] || '');
  }
}

function readCodeFence(input, start) {
  if (start > 0 && input[start - 1] !== '\n') return null;
  const match = /^( {0,3})(`{3,}|~{3,})/.exec(input.slice(start));
  if (!match) return null;
  const marker = match[2][0];
  const size = match[2].length;
  const lineEnd = input.indexOf('\n', start + match[0].length);
  if (lineEnd < 0) return { value: input.slice(start), end: input.length };
  const closing = new RegExp(`^ {0,3}${escapeRegex(marker)}{${size},}[ \\t]*$`, 'm');
  const tail = input.slice(lineEnd + 1);
  const close = closing.exec(tail);
  if (!close) return { value: input.slice(start), end: input.length };
  const end = lineEnd + 1 + close.index + close[0].length;
  return { value: input.slice(start, end), end };
}

function readInlineCode(input, start) {
  if (input[start] !== '`') return null;
  let size = 1;
  while (input[start + size] === '`') size += 1;
  const delimiter = '`'.repeat(size);
  const endStart = input.indexOf(delimiter, start + size);
  if (endStart < 0) return null;
  const end = endStart + size;
  return { value: input.slice(start, end), end };
}

function readMathSpan(input, start) {
  const pairs = [
    ['\\[', '\\]'],
    ['\\(', '\\)'],
    ['$$', '$$'],
    ['$', '$'],
  ];
  for (const [left, right] of pairs) {
    if (!input.startsWith(left, start) || isEscaped(input, start)) continue;
    const closeAt = findUnescaped(input, right, start + left.length);
    if (closeAt < 0) continue;
    const end = closeAt + right.length;
    return { value: stripBlockquoteMathMarkers(input.slice(start, end), input, start), end };
  }
  return null;
}

export function stripBlockquoteMathMarkers(value, source = '', start = 0) {
  const lineStart = source.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const prefix = source.slice(lineStart, start);
  if (!/^ {0,3}>[ \t]?$/.test(prefix)) return value;
  return String(value).replace(/\n {0,3}> ?/g, '\n');
}

function findUnescaped(input, delimiter, from) {
  let at = input.indexOf(delimiter, from);
  while (at >= 0) {
    if (!isEscaped(input, at)) return at;
    at = input.indexOf(delimiter, at + delimiter.length);
  }
  return -1;
}

function isEscaped(input, at) {
  let slashes = 0;
  for (let i = at - 1; i >= 0 && input[i] === '\\'; i -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function injectCitations(root, sources) {
  const byNumber = new Map();
  for (const source of sources || []) {
    const match = /^\[S(\d+)\]$/.exec(source.citation || '');
    if (match) byNumber.set(match[1], source);
  }
  if (!byNumber.size) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (/\[S\d+\]/.test(node.nodeValue || '') && !node.parentElement?.closest('a, code, pre, .katex')) nodes.push(node);
  }

  for (const node of nodes) {
    const fragment = document.createDocumentFragment();
    const text = node.nodeValue || '';
    const re = /\[S(\d+)\]/g;
    let from = 0;
    let match;
    while ((match = re.exec(text))) {
      fragment.append(text.slice(from, match.index));
      const source = byNumber.get(match[1]);
      if (source) fragment.append(createCitation(source, match[1]));
      else fragment.append(match[0]);
      from = match.index + match[0].length;
    }
    fragment.append(text.slice(from));
    node.replaceWith(fragment);
  }
}

function createCitation(source, number) {
  const anchor = document.createElement('a');
  anchor.className = 'ai-citation';
  anchor.href = source.url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.textContent = `[${number}]`;
  anchor.setAttribute('aria-label', `来源 ${number}：${source.title}`);

  const linkIcon = document.createElement('span');
  linkIcon.className = 'ai-citation-link-icon';
  linkIcon.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 9.5l3-3M5 11l-1 1a2.1 2.1 0 01-3-3l2-2a2.1 2.1 0 013 0M11 5l1-1a2.1 2.1 0 013 3l-2 2a2.1 2.1 0 01-3 0" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  anchor.prepend(linkIcon);

  const hover = document.createElement('span');
  hover.className = 'ai-citation-hover';
  const title = document.createElement('strong');
  title.textContent = source.title || source.url;
  const meta = document.createElement('small');
  meta.textContent = `${source.provider || 'Web'} · ${hostname(source.url)}`;
  const excerpt = document.createElement('span');
  excerpt.textContent = source.excerpt || '点击打开来源';
  hover.append(title, meta, excerpt);
  let removeTimer;
  let watchFrame;
  let scrollHost;
  const dismiss = () => hideHover(true);
  const hideHover = (immediate = false) => {
    cancelAnimationFrame(watchFrame);
    watchFrame = 0;
    window.removeEventListener('blur', dismiss);
    scrollHost?.removeEventListener('scroll', dismiss);
    hover.classList.remove('is-visible');
    clearTimeout(removeTimer);
    if (immediate) hover.remove();
    else removeTimer = setTimeout(() => hover.remove(), 180);
  };
  const watchAnchor = () => {
    if (!anchor.isConnected) { hideHover(true); return; }
    watchFrame = requestAnimationFrame(watchAnchor);
  };
  const showHover = () => {
    clearTimeout(removeTimer);
    if (hover.parentNode !== document.body) document.body.append(hover);
    const anchorRect = anchor.getBoundingClientRect();
    const hoverRect = hover.getBoundingClientRect();
    const gap = 8;
    const left = Math.max(8, Math.min(innerWidth - hoverRect.width - 8, anchorRect.left - hoverRect.width * 0.28));
    const above = anchorRect.top - hoverRect.height - gap;
    hover.style.left = `${Math.round(left)}px`;
    hover.style.top = `${Math.round(above >= 8 ? above : anchorRect.bottom + gap)}px`;
    requestAnimationFrame(() => hover.classList.add('is-visible'));
    cancelAnimationFrame(watchFrame);
    watchFrame = requestAnimationFrame(watchAnchor);
    scrollHost = anchor.closest('.ai-messages');
    window.addEventListener('blur', dismiss, { once: true });
    scrollHost?.addEventListener('scroll', dismiss, { passive: true, once: true });
  };
  anchor.addEventListener('pointerenter', showHover);
  anchor.addEventListener('pointerleave', hideHover);
  anchor.addEventListener('focus', showHover);
  anchor.addEventListener('blur', hideHover);
  return anchor;
}

function injectGraphReferences(root, labelIndex, handlers) {
  const labels = labelIndex instanceof Map ? labelIndex : new Map();
  for (const code of [...root.querySelectorAll('code:not(pre code)')]) {
    const key = code.textContent?.trim();
    const entry = key && labels.get(key);
    if (entry) code.replaceWith(createGraphReference(formatGraphReferenceDisplay(entry, key), entry, handlers, key));
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const value = node.nodeValue || '';
    if ((/\\(?:ref|eqref)\{[^}\n]+\}/.test(value) || /[-\w.]+:[-\w.:]+/.test(value))
      && !node.parentElement?.closest('a, button, code, pre, .katex')) nodes.push(node);
  }
  for (const node of nodes) {
    const text = node.nodeValue || '';
    const pattern = /\\(ref|eqref)\{([^}\n]+)\}|([-\w.]+:[-\w.:]+)/g;
    const fragment = document.createDocumentFragment();
    let from = 0;
    let match;
    let changed = false;
    while ((match = pattern.exec(text))) {
      const syntax = match[1] || 'ref';
      const key = (match[2] || match[3] || '').trim();
      const entry = labels.get(key);
      if (!entry && !match[1]) continue;
      const replacement = entry
        ? createGraphReference(formatGraphReferenceDisplay(entry, key, syntax), entry, handlers, key)
        : createUnresolvedFileReference(syntax, key);
      fragment.append(text.slice(from, match.index), replacement);
      from = match.index + match[0].length;
      changed = true;
    }
    if (!changed) continue;
    fragment.append(text.slice(from));
    node.replaceWith(fragment);
  }
}

function createUnresolvedFileReference(syntax, key) {
  const span = document.createElement('span');
  span.className = 'ai-file-ref';
  span.textContent = formatUnresolvedFileReference(syntax, key);
  span.title = `上传文件中的内部引用未链接到当前图谱：${key}`;
  return span;
}

export function formatUnresolvedFileReference(syntax = 'ref', key = '') {
  const normalized = String(key || '').trim();
  const [prefix = '', ...tail] = normalized.split(':');
  const kind = syntax === 'eqref' ? '公式' : ({
    thm: '定理', theorem: '定理', lem: '引理', lemma: '引理',
    prop: '命题', proposition: '命题', cor: '推论', corollary: '推论',
    def: '定义', definition: '定义', sec: '章节', section: '章节',
  }[prefix.toLowerCase()] || '文内引用');
  const identifier = (tail.join(':') || (syntax === 'eqref' ? normalized : '')).replace(/[-_.]+/g, ' ').trim();
  return identifier ? `${kind}「${identifier}」` : kind;
}

/**
 * Keep AI citations visually consistent with the graph node and label UI while
 * retaining the internal id as the navigation key.
 */
export function formatGraphReferenceDisplay(entry, key = '', syntax = 'ref') {
  const label = entry?.label;
  const node = entry?.node;
  if (label?.kind === 'equation' && label.number) return `(${label.number})`;
  if (syntax === 'eqref' && label?.number) return `(${label.number})`;
  const type = node?.typeLabel || node?.type || '';
  const number = node?.number || label?.number || '';
  return [type, number].filter(Boolean).join(' ') || key;
}

function createGraphReference(display, entry, handlers, key = display) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ai-graph-ref';
  button.textContent = display;
  const node = entry.node;
  const label = entry.label;
  button.setAttribute('aria-label', `图谱引用：${node?.title || key}`);
  button.classList.toggle('is-equation', label?.kind === 'equation');
  button.dataset.label = key;
  let longPressed = false;
  let suppressClick = false;
  let touchTimer;
  button.addEventListener('click', (event) => {
    if (suppressClick) {
      event.preventDefault();
      event.stopPropagation();
      suppressClick = false;
      return;
    }
    handlers?.onNavigate?.(node, label);
  });

  if (handlers?.onHover) {
    button.addEventListener('pointerenter', (event) => { if (event.pointerType !== 'touch') handlers.onHover(button, node, label); });
    button.addEventListener('pointerleave', (event) => { if (event.pointerType !== 'touch') handlers.onLeave?.(button, node, label); });
    button.addEventListener('focus', () => handlers.onHover(button, node, label));
    button.addEventListener('blur', () => handlers.onLeave?.(button, node, label));
    button.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'touch') return;
      clearTimeout(touchTimer);
      longPressed = false;
      suppressClick = false;
      touchTimer = setTimeout(() => {
        longPressed = true;
        suppressClick = true;
        handlers.onHover(button, node, label);
      }, 480);
    });
    button.addEventListener('pointerup', (event) => {
      if (event.pointerType !== 'touch') return;
      clearTimeout(touchTimer);
      if (longPressed) { event.preventDefault(); event.stopPropagation(); }
    });
    button.addEventListener('pointercancel', () => clearTimeout(touchTimer));
    return button;
  }

  const hover = document.createElement('span');
  hover.className = 'ai-graph-ref-hover';
  const heading = document.createElement('strong');
  heading.textContent = [node?.typeLabel || node?.type, node?.number, node?.title].filter(Boolean).join(' · ') || key;
  const meta = document.createElement('small');
  meta.textContent = `图谱节点 · ${label?.kind || 'label'}`;
  const excerpt = document.createElement('span');
  excerpt.textContent = truncatePlainText(node?.statementBody || node?.sections?.[0]?.body || node?.proofBody || '点击跳转到对应图谱节点', 220);
  hover.append(heading, meta, excerpt);
  attachReferenceHover(button, hover);
  return button;
}

function attachReferenceHover(anchor, hover) {
  let timer;
  let watchFrame;
  let scrollHost;
  let touchTimer;
  let longPressed = false;
  let suppressClick = false;
  const dismiss = () => hide(true);
  const hide = (immediate = false) => {
    cancelAnimationFrame(watchFrame);
    watchFrame = 0;
    window.removeEventListener('blur', dismiss);
    scrollHost?.removeEventListener('scroll', dismiss);
    clearTimeout(timer);
    hover.classList.remove('is-visible');
    if (immediate) hover.remove();
    else timer = setTimeout(() => hover.remove(), 160);
  };
  const watchAnchor = () => {
    if (!anchor.isConnected) { hide(true); return; }
    watchFrame = requestAnimationFrame(watchAnchor);
  };
  const show = () => {
    clearTimeout(timer);
    if (hover.parentNode !== document.body) document.body.append(hover);
    const rect = anchor.getBoundingClientRect();
    const popup = hover.getBoundingClientRect();
    hover.style.left = `${Math.round(Math.max(8, Math.min(innerWidth - popup.width - 8, rect.left)))}px`;
    hover.style.top = `${Math.round(rect.top - popup.height - 8 > 8 ? rect.top - popup.height - 8 : rect.bottom + 8)}px`;
    requestAnimationFrame(() => hover.classList.add('is-visible'));
    scrollHost = anchor.closest('.ai-messages');
    cancelAnimationFrame(watchFrame);
    watchFrame = requestAnimationFrame(watchAnchor);
    window.addEventListener('blur', dismiss, { once: true });
    scrollHost?.addEventListener('scroll', dismiss, { passive: true, once: true });
  };
  anchor.addEventListener('pointerenter', (event) => { if (event.pointerType !== 'touch') show(); });
  anchor.addEventListener('pointerleave', (event) => { if (event.pointerType !== 'touch' && !longPressed) hide(); });
  anchor.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'touch') return;
    clearTimeout(touchTimer);
    longPressed = false;
    suppressClick = false;
    touchTimer = setTimeout(() => {
      longPressed = true;
      suppressClick = true;
      show();
    }, 480);
  });
  anchor.addEventListener('pointerup', (event) => {
    if (event.pointerType !== 'touch') return;
    clearTimeout(touchTimer);
    if (longPressed) { event.preventDefault(); event.stopPropagation(); }
  });
  anchor.addEventListener('pointercancel', () => clearTimeout(touchTimer));
  anchor.addEventListener('focus', show);
  anchor.addEventListener('blur', () => hide());
  anchor.addEventListener('click', (event) => {
    if (suppressClick) {
      event.preventDefault();
      event.stopPropagation();
      suppressClick = false;
      return;
    }
    hide(true);
  });
}

function truncatePlainText(value, max) {
  const text = String(value || '').replace(/\\(?:label|ref|eqref|cite)\{[^}]+\}/g, '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max).trim()}…` : text;
}

function hostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url || ''; }
}
