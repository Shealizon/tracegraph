import { renderMarkdownInto } from '../render/markdown.js';
import { ICON } from './icons.js';
import { toast } from './feedback.js';

const PDF_RECT_KEY = 'paper-graph:pdf-preview-rect';
const TEXT_RECT_KEY = 'paper-graph:text-preview-rect';

export function workspaceFileKind(file) {
  const path = String(file?.path || file?.name || '').toLowerCase();
  const type = String(file?.type || '').toLowerCase();
  if (type === 'application/pdf' || /\.pdf$/i.test(path)) return 'pdf';
  if (type === 'text/markdown' || /\.(md|markdown)$/i.test(path)) return 'markdown';
  if (type.startsWith('image/') || /\.(avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i.test(path)) return 'image';
  if (type.startsWith('text/') || /\.(txt|log)$/i.test(path)) return 'text';
  if (/\.(csv|ods|xls|xlsx)$/i.test(path)) return 'spreadsheet';
  if (/\.(doc|docx|odt|rtf)$/i.test(path)) return 'document';
  if (/\.(odp|ppt|pptx)$/i.test(path)) return 'presentation';
  if (/\.(7z|bz2|gz|rar|tar|tgz|zip)$/i.test(path)) return 'archive';
  if (/\.(c|cc|cpp|css|go|h|hpp|html|java|js|json|jsx|mjs|py|rs|sh|ts|tsx|xml|yaml|yml)$/i.test(path)) return 'code';
  return 'file';
}

export function workspaceFileIcon(file) {
  const kind = typeof file === 'string' ? file : workspaceFileKind(file);
  const icons = {
    pdf: fileGlyph('<path d="M8 11.5h2.2a1.7 1.7 0 010 3.4H8v-5.8M13 14.9V9.1h1.6a2.9 2.9 0 010 5.8H13M18 14.9V9.1h3"/>'),
    markdown: fileGlyph('<path d="M7.5 15v-5l2.1 2.6 2.1-2.6v5M14 11.5l2 2 2-2M16 9v5"/>'),
    image: fileGlyph('<circle cx="10" cy="10" r="1.2"/><path d="m7.5 16 3.1-3.1 2.1 2.1 1.5-1.5 2.3 2.5"/>'),
    text: fileGlyph('<path d="M8 10h8M8 13h8M8 16h5"/>'),
    spreadsheet: fileGlyph('<path d="M8 10h8v6H8zM8 13h8M12 10v6"/>'),
    document: fileGlyph('<path d="M8 10h8M8 13h8M8 16h6"/>'),
    presentation: fileGlyph('<path d="M8 10h8v5H8zM12 15v2M10 17h4"/>'),
    archive: fileGlyph('<path d="M11 8h2M11 10.5h2M11 13h2M10.5 15.5h3v2h-3z"/>'),
    code: fileGlyph('<path d="m11 10-2.5 2.5L11 15M14 10l2.5 2.5L14 15"/>'),
    file: fileGlyph(''),
  };
  return icons[kind] || icons.file;
}

export function isPreviewableWorkspaceFile(file) {
  return ['pdf', 'markdown', 'text', 'image'].includes(workspaceFileKind(file));
}

export async function downloadWorkspaceFile(file, name = file?.name || 'download') {
  if (!file) throw new Error('文件不存在');
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name || 'download';
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function createWorkspacePreviewController({ markdownOptions = () => ({}), onPdfField = () => false } = {}) {
  let active = null;
  let requestVersion = 0;

  function close() {
    requestVersion += 1;
    active?.close?.();
    active = null;
  }

  async function open({ file, path, name, conversationId }) {
    close();
    const version = requestVersion;
    const source = {
      file,
      path,
      name: name || file?.name || String(path).split('/').pop(),
      conversationId,
    };
    let next;
    const kind = workspaceFileKind({ path, name: source.name, type: file?.type });
    if (kind === 'pdf') next = await openPdfPreview(source, onPdfField);
    else if (kind === 'markdown' || kind === 'text') next = await openTextPreview(source, markdownOptions, kind);
    else if (kind === 'image') next = await openImagePreview(source);
    else throw new Error('当前只支持预览 PDF、Markdown、TXT 和图片文件');
    if (version !== requestVersion) {
      next?.close?.();
      return null;
    }
    active = next;
    return active?.element || null;
  }

  return {
    open,
    close,
    closePath(path) { if (active?.path === path) close(); },
    get path() { return active?.path || ''; },
  };
}

async function openTextPreview(source, markdownOptions, kind = workspaceFileKind(source)) {
  const text = await source.file.text();
  const shell = document.createElement('aside');
  shell.className = 'tag-note-hover-preview note-window ai-workspace-preview ai-text-file-preview';
  shell.setAttribute('role', 'dialog');
  shell.setAttribute('aria-label', `文件预览：${source.name}`);
  shell.innerHTML = `<header class="ai-file-preview-head" data-drag-handle><span data-kind="${kind}">${workspaceFileIcon(kind)}</span><div><strong></strong><small>${kind === 'markdown' ? 'Markdown · 只读' : '纯文本 · 只读'}</small></div><button type="button" title="下载">${ICON.download}</button><button type="button" title="关闭">${ICON.close}</button></header><div class="tag-note-hover-body ai-file-preview-body"></div>`;
  shell.querySelector('strong').textContent = source.name;
  const [download, dismiss] = shell.querySelectorAll('header > button');
  download.addEventListener('click', () => downloadWorkspaceFile(source.file, source.name));
  const body = shell.querySelector('.ai-file-preview-body');
  if (kind === 'markdown') {
    body.classList.add('ai-markdown', 'tag-note-preview-content');
    renderMarkdownInto(body, text || '*空文件*', markdownOptions());
  } else {
    const pre = document.createElement('pre');
    pre.className = 'ai-file-plain-text';
    pre.textContent = text;
    body.append(pre);
  }
  document.body.append(shell);
  applySavedRect(shell, TEXT_RECT_KEY, defaultTextRect());
  const disconnectDrag = bindDrag(shell, shell.querySelector('[data-drag-handle]'), () => saveRect(shell, TEXT_RECT_KEY));
  const observer = observeRect(shell, TEXT_RECT_KEY);
  const close = () => {
    disconnectDrag();
    observer?.disconnect();
    shell.remove();
  };
  dismiss.addEventListener('click', close);
  return { element: shell, path: source.path, close };
}

async function openImagePreview(source) {
  const shell = document.createElement('aside');
  shell.className = 'tag-note-hover-preview note-window ai-workspace-preview ai-image-file-preview';
  shell.setAttribute('role', 'dialog');
  shell.setAttribute('aria-label', `图片预览：${source.name}`);
  shell.innerHTML = `<header class="ai-file-preview-head" data-drag-handle><span data-kind="image">${workspaceFileIcon('image')}</span><div><strong></strong><small>图片 · 只读</small></div><button type="button" title="下载">${ICON.download}</button><button type="button" title="关闭">${ICON.close}</button></header><div class="ai-file-preview-body ai-image-preview-body"><img alt=""></div>`;
  shell.querySelector('strong').textContent = source.name;
  const [download, dismiss] = shell.querySelectorAll('header > button');
  const image = shell.querySelector('img');
  const detail = shell.querySelector('small');
  const objectUrl = URL.createObjectURL(source.file);
  image.alt = source.name;
  image.src = objectUrl;
  image.addEventListener('load', () => {
    if (image.naturalWidth && image.naturalHeight) detail.textContent = `图片 · ${image.naturalWidth} × ${image.naturalHeight} · 只读`;
  });
  download.addEventListener('click', () => downloadWorkspaceFile(source.file, source.name));
  document.body.append(shell);
  applySavedRect(shell, TEXT_RECT_KEY, defaultTextRect());
  const disconnectDrag = bindDrag(shell, shell.querySelector('[data-drag-handle]'), () => saveRect(shell, TEXT_RECT_KEY));
  const observer = observeRect(shell, TEXT_RECT_KEY);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    disconnectDrag();
    observer?.disconnect();
    URL.revokeObjectURL(objectUrl);
    shell.remove();
  };
  dismiss.addEventListener('click', close);
  return { element: shell, path: source.path, close };
}

async function openPdfPreview(source, onPdfField) {
  const { createPdfTextLayer, openPdfDocument } = await import('../ai/pdf.js');
  const shell = document.createElement('aside');
  shell.className = 'ai-pdf-preview';
  shell.setAttribute('role', 'dialog');
  shell.setAttribute('aria-label', `PDF 阅读器：${source.name}`);
  shell.innerHTML = `<header class="ai-pdf-preview-head" data-drag-handle><span class="ai-pdf-preview-mark" data-kind="pdf">${workspaceFileIcon('pdf')}</span><div><strong></strong><small>PDF 阅读器</small></div><div class="ai-pdf-window-controls"><button type="button" data-window-smaller title="等比缩小窗口">${minusIcon()}</button><button type="button" data-window-larger title="等比放大窗口">${ICON.plus}</button><button type="button" data-download title="下载">${ICON.download}</button><button type="button" data-close title="关闭">${ICON.close}</button></div></header><div class="ai-pdf-toolbar"><button type="button" data-prev title="上一页">${leftIcon()}</button><form data-page-form><label>第 <input type="number" min="1" value="1" inputmode="numeric"> 页</label><span>/ <b data-page-count>—</b></span></form><button type="button" data-next title="下一页">${rightIcon()}</button><small data-page-status>正在加载…</small></div><div class="ai-pdf-stage"><div class="ai-pdf-loading">正在打开 PDF…</div><div class="ai-pdf-page" hidden><canvas></canvas><div class="textLayer"></div></div></div><span class="ai-pdf-resize-handle" aria-hidden="true"></span>`;
  shell.querySelector('strong').textContent = source.name;
  document.body.append(shell);
  applySavedRect(shell, PDF_RECT_KEY, defaultPdfRect());

  const selectionBar = document.createElement('div');
  selectionBar.className = 'ai-pdf-selection-actions';
  selectionBar.hidden = true;
  selectionBar.innerHTML = `<button type="button" data-pdf-reference>${quoteIcon()}<span>PDF 字段引用</span></button><button type="button" data-copy-text>${copyIcon()}<span>复制文本</span></button>`;
  document.body.append(selectionBar);

  let documentHandle = null;
  let pageNumber = 1;
  let renderTask = null;
  let textLayer = null;
  let renderVersion = 0;
  let selectionSnapshot = null;
  let closed = false;
  let resizeTimer = 0;
  const stage = shell.querySelector('.ai-pdf-stage');
  const pageElement = shell.querySelector('.ai-pdf-page');
  const canvas = pageElement.querySelector('canvas');
  const textLayerElement = pageElement.querySelector('.textLayer');
  const status = shell.querySelector('[data-page-status]');
  const pageInput = shell.querySelector('[data-page-form] input');
  const previous = shell.querySelector('[data-prev]');
  const next = shell.querySelector('[data-next]');

  const hideSelection = ({ clear = false } = {}) => {
    selectionBar.hidden = true;
    selectionSnapshot = null;
    if (clear) window.getSelection()?.removeAllRanges();
  };

  const updateSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) { hideSelection(); return; }
    const anchor = selection.anchorNode?.parentElement || selection.anchorNode;
    const focus = selection.focusNode?.parentElement || selection.focusNode;
    if (!textLayerElement.contains(anchor) || !textLayerElement.contains(focus)) { hideSelection(); return; }
    const text = selection.toString().replace(/\s+/g, ' ').trim();
    if (!text) { hideSelection(); return; }
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const pageRect = pageElement.getBoundingClientRect();
    const rects = [...range.getClientRects()]
      .filter((item) => item.width > 0 && item.height > 0)
      .map((item) => ({
        x: (item.left - pageRect.left) / pageRect.width,
        y: (item.top - pageRect.top) / pageRect.height,
        width: item.width / pageRect.width,
        height: item.height / pageRect.height,
      }));
    selectionSnapshot = { text, rects };
    selectionBar.style.left = `${Math.round(clamp(rect.left, 8, innerWidth - 260))}px`;
    selectionBar.style.top = `${Math.round(rect.top > 54 ? rect.top - 42 : rect.bottom + 8)}px`;
    selectionBar.hidden = false;
  };

  const renderPage = async () => {
    if (!documentHandle || closed) return;
    const version = ++renderVersion;
    hideSelection({ clear: true });
    renderTask?.cancel?.();
    textLayer?.cancel?.();
    status.textContent = `第 ${pageNumber} 页`;
    pageInput.value = String(pageNumber);
    previous.disabled = pageNumber <= 1;
    next.disabled = pageNumber >= documentHandle.numPages;
    const page = await documentHandle.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(220, stage.clientWidth - 30);
    const viewport = page.getViewport({ scale: availableWidth / base.width });
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    pageElement.style.width = `${Math.floor(viewport.width)}px`;
    pageElement.style.height = `${Math.floor(viewport.height)}px`;
    pageElement.style.setProperty('--scale-factor', String(viewport.scale));
    textLayerElement.replaceChildren();
    textLayerElement.style.width = `${Math.floor(viewport.width)}px`;
    textLayerElement.style.height = `${Math.floor(viewport.height)}px`;
    pageElement.hidden = false;
    shell.querySelector('.ai-pdf-loading').hidden = true;
    renderTask = page.render({
      canvas,
      canvasContext: canvas.getContext('2d', { alpha: false }),
      viewport,
      transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
    });
    textLayer = createPdfTextLayer({
      textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
      container: textLayerElement,
      viewport,
    });
    try {
      await Promise.all([renderTask.promise, textLayer.render()]);
      if (version !== renderVersion || closed) return;
      status.textContent = `第 ${pageNumber} 页 · ${Math.round(viewport.width)} × ${Math.round(viewport.height)}`;
    } catch (error) {
      if (error?.name !== 'RenderingCancelledException' && !closed) throw error;
    }
  };

  const goToPage = (value) => {
    if (!documentHandle) return;
    const nextPage = clamp(Math.round(Number(value) || 1), 1, documentHandle.numPages);
    if (nextPage === pageNumber && !pageElement.hidden) return;
    pageNumber = nextPage;
    stage.scrollTop = 0;
    renderPage().catch((error) => { status.textContent = error?.message || '页面渲染失败'; });
  };

  const resizeWindow = (factor) => {
    const rect = shell.getBoundingClientRect();
    const width = clamp(Math.round(rect.width * factor), 360, innerWidth - 16);
    const height = clamp(Math.round(rect.height * factor), 420, innerHeight - 16);
    const proportional = Math.min(width / rect.width, height / rect.height);
    shell.style.width = `${Math.round(rect.width * proportional)}px`;
    shell.style.height = `${Math.round(rect.height * proportional)}px`;
    clampWindow(shell);
    saveRect(shell, PDF_RECT_KEY);
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderPage().catch(() => {}), 80);
  };

  previous.addEventListener('click', () => goToPage(pageNumber - 1));
  next.addEventListener('click', () => goToPage(pageNumber + 1));
  shell.querySelector('[data-page-form]').addEventListener('submit', (event) => { event.preventDefault(); goToPage(pageInput.value); });
  shell.querySelector('[data-window-smaller]').addEventListener('click', () => resizeWindow(0.9));
  shell.querySelector('[data-window-larger]').addEventListener('click', () => resizeWindow(1.1));
  shell.querySelector('[data-download]').addEventListener('click', () => downloadWorkspaceFile(source.file, source.name));
  shell.querySelector('[data-close]').addEventListener('click', () => close());
  stage.addEventListener('pointerup', () => setTimeout(updateSelection, 0));
  stage.addEventListener('keyup', () => setTimeout(updateSelection, 0));
  stage.addEventListener('scroll', () => { if (!selectionBar.hidden) updateSelection(); }, { passive: true });
  shell.addEventListener('copy', (event) => {
    const text = window.getSelection()?.toString();
    if (!text) return;
    event.preventDefault();
    event.clipboardData?.setData('text/plain', text);
  });
  for (const button of selectionBar.querySelectorAll('button')) button.addEventListener('pointerdown', (event) => event.preventDefault());
  selectionBar.querySelector('[data-copy-text]').addEventListener('click', async () => {
    if (!selectionSnapshot?.text) return;
    await writePlainText(selectionSnapshot.text);
    toast('已复制纯文本');
  });
  selectionBar.querySelector('[data-pdf-reference]').addEventListener('click', () => {
    if (!selectionSnapshot?.text) return;
    const attached = onPdfField({
      path: source.path,
      name: source.name,
      page: pageNumber,
      text: selectionSnapshot.text,
      rects: selectionSnapshot.rects,
      conversationId: source.conversationId,
    });
    toast(attached ? '已添加 PDF 字段引用' : '该 PDF 不属于当前对话', { type: attached ? 'success' : 'error' });
    if (attached) hideSelection({ clear: true });
  });

  const disconnectDrag = bindDrag(shell, shell.querySelector('[data-drag-handle]'), () => {
    hideSelection();
    saveRect(shell, PDF_RECT_KEY);
  });
  const disconnectResize = bindProportionalResize(shell, shell.querySelector('.ai-pdf-resize-handle'), () => {
    saveRect(shell, PDF_RECT_KEY);
    renderPage().catch(() => {});
  });
  const onWindowResize = () => { clampWindow(shell); renderPage().catch(() => {}); };
  window.addEventListener('resize', onWindowResize);

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(resizeTimer);
    renderTask?.cancel?.();
    textLayer?.cancel?.();
    documentHandle?.destroy?.();
    disconnectDrag();
    disconnectResize();
    window.removeEventListener('resize', onWindowResize);
    selectionBar.remove();
    shell.remove();
  };

  try {
    documentHandle = await openPdfDocument(source.file);
    if (closed) return { element: shell, path: source.path, close };
    shell.querySelector('[data-page-count]').textContent = String(documentHandle.numPages);
    pageInput.max = String(documentHandle.numPages);
    await renderPage();
  } catch (error) {
    close();
    throw error;
  }
  return { element: shell, path: source.path, close };
}

function bindDrag(element, handle, onEnd = () => {}) {
  let start = null;
  const down = (event) => {
    if (event.button !== 0 || event.target.closest('button, input, a')) return;
    const rect = element.getBoundingClientRect();
    start = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    handle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };
  const move = (event) => {
    if (!start) return;
    element.style.left = `${clamp(start.left + event.clientX - start.x, 8, innerWidth - element.offsetWidth - 8)}px`;
    element.style.top = `${clamp(start.top + event.clientY - start.y, 8, innerHeight - element.offsetHeight - 8)}px`;
  };
  const up = () => { if (!start) return; start = null; onEnd(); };
  handle.addEventListener('pointerdown', down);
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
  return () => {
    handle.removeEventListener('pointerdown', down);
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', up);
  };
}

function bindProportionalResize(element, handle, onEnd = () => {}) {
  let start = null;
  const down = (event) => {
    if (event.button !== 0) return;
    const rect = element.getBoundingClientRect();
    start = { x: event.clientX, y: event.clientY, width: rect.width, height: rect.height };
    handle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };
  const move = (event) => {
    if (!start) return;
    const factor = Math.max((start.width + event.clientX - start.x) / start.width, (start.height + event.clientY - start.y) / start.height);
    const limited = clamp(factor, 360 / start.width, Math.min((innerWidth - element.offsetLeft - 8) / start.width, (innerHeight - element.offsetTop - 8) / start.height));
    element.style.width = `${Math.round(start.width * limited)}px`;
    element.style.height = `${Math.round(start.height * limited)}px`;
  };
  const up = () => { if (!start) return; start = null; onEnd(); };
  handle.addEventListener('pointerdown', down);
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
  return () => {
    handle.removeEventListener('pointerdown', down);
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', up);
  };
}

function observeRect(element, key) {
  if (!window.ResizeObserver) return null;
  let timer = 0;
  const observer = new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => { clampWindow(element); saveRect(element, key); }, 120);
  });
  observer.observe(element);
  return observer;
}

function applySavedRect(element, key, fallback) {
  let rect = fallback;
  try { rect = { ...fallback, ...JSON.parse(localStorage.getItem(key) || 'null') }; } catch { /* use fallback */ }
  element.style.width = `${clamp(rect.width, 320, innerWidth - 16)}px`;
  element.style.height = `${clamp(rect.height, 320, innerHeight - 16)}px`;
  element.style.left = `${clamp(rect.left, 8, innerWidth - Number.parseFloat(element.style.width) - 8)}px`;
  element.style.top = `${clamp(rect.top, 8, innerHeight - Number.parseFloat(element.style.height) - 8)}px`;
}

function saveRect(element, key) {
  const rect = element.getBoundingClientRect();
  localStorage.setItem(key, JSON.stringify({
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }));
}

function clampWindow(element) {
  const rect = element.getBoundingClientRect();
  element.style.width = `${Math.min(rect.width, innerWidth - 16)}px`;
  element.style.height = `${Math.min(rect.height, innerHeight - 16)}px`;
  element.style.left = `${clamp(rect.left, 8, innerWidth - Math.min(rect.width, innerWidth - 16) - 8)}px`;
  element.style.top = `${clamp(rect.top, 8, innerHeight - Math.min(rect.height, innerHeight - 16) - 8)}px`;
}

function defaultPdfRect() {
  const width = innerWidth <= 760 ? innerWidth - 16 : Math.min(720, Math.max(420, Math.round(innerWidth * 0.48)));
  const height = Math.min(innerHeight - 24, Math.max(480, Math.round(width * 1.2)));
  return { left: 12, top: Math.max(12, Math.round((innerHeight - height) / 2)), width, height };
}

function defaultTextRect() {
  const width = Math.min(520, innerWidth - 24);
  const height = Math.min(640, innerHeight - 32);
  return { left: 16, top: 16, width, height };
}

async function writePlainText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(String(text || ''));
  const textarea = document.createElement('textarea');
  textarea.value = String(text || '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function clamp(value, min, max) {
  const number = Number(value);
  return Math.max(min, Math.min(Math.max(min, max), Number.isFinite(number) ? number : min));
}

function fileGlyph(content) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 2.8h7l4 4v14.4h-11zM13.5 2.8v4h4"/>${content}</svg>`;
}

function minusIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'; }
function leftIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 5.5L8 10l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
function rightIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 5.5L12 10l-4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
function quoteIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 5.5h4v4a4 4 0 01-3.7 4M11.5 5.5h4v4a4 4 0 01-3.7 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'; }
function copyIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M13 7V5.5A1.5 1.5 0 0011.5 4h-7A1.5 1.5 0 003 5.5v7A1.5 1.5 0 004.5 14H7" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>'; }
