import { renderMarkdownInto } from '../render/markdown.js';
import { fileFragmentReference } from '../data/fileReference.js';
import { ICON } from './icons.js';
import { toast } from './feedback.js';
import { writeGraphReference } from './graphClipboard.js';

const PDF_RECT_KEY = 'tracegraph:pdf-preview-rect';
const TEXT_RECT_KEY = 'tracegraph:text-preview-rect';

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
    pdf: fileTypeSvg('<path d="M6.5 2.75h7l4 4v14.5h-11z"/><path d="M13.5 2.75v4h4"/><rect x="8.5" y="12.25" width="7" height="4.5" rx="1" fill="currentColor" stroke="none"/>'),
    markdown: fileTypeSvg('<rect x="2.75" y="5.25" width="18.5" height="13.5" rx="2.25"/><path d="M6 15v-6l3 3 3-3v6M15 12l2.5 2.5L20 12M17.5 9v5.5"/>'),
    image: fileTypeSvg('<rect x="3" y="4" width="18" height="16" rx="2.25"/><circle cx="8.25" cy="9" r="1.5"/><path d="m5.5 17 4.75-4.75 3.25 3.25 2.5-2.5 2.5 2.5"/>'),
    text: fileTypeSvg('<path d="M6.5 2.75h7l4 4v14.5h-11z"/><path d="M13.5 2.75v4h4M9 11h6M9 14h6M9 17h4.5"/>'),
    spreadsheet: fileTypeSvg('<rect x="3.25" y="3.25" width="17.5" height="17.5" rx="2.25"/><path d="M3.25 9h17.5M9 9v11.75M15 9v11.75M3.25 15h17.5"/>'),
    document: fileTypeSvg('<path d="M6.5 2.75h7l4 4v14.5h-11z"/><path d="M13.5 2.75v4h4M9 10.5h6M9 13.5h6M9 16.5h6"/>'),
    presentation: fileTypeSvg('<rect x="3" y="4" width="18" height="13" rx="2.25"/><path d="M12 17v4M8.5 21h7M8 13V8.5h8V13"/>'),
    archive: fileTypeSvg('<path d="M4 8h16v12H4zM3 4h18v4H3zM9 13h6"/>'),
    code: fileTypeSvg('<rect x="3" y="4" width="18" height="16" rx="2.25"/><path d="m10 9-3 3 3 3M14 9l3 3-3 3"/>'),
    file: fileTypeSvg('<path d="M6.5 2.75h7l4 4v14.5h-11z"/><path d="M13.5 2.75v4h4"/>'),
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

export function createWorkspacePreviewController({
  markdownOptions = () => ({}),
  onAttachFile = () => false,
  onAddMarkdownToNotes = () => false,
  onPdfField = () => false,
  onTextExcerpt = () => false,
} = {}) {
  let active = null;
  let requestVersion = 0;

  function close() {
    requestVersion += 1;
    active?.close?.();
    active = null;
  }

  async function open({ file, path, name, conversationId, fragment = null }) {
    close();
    const version = requestVersion;
    const source = {
      file,
      path,
      name: name || file?.name || String(path).split('/').pop(),
      conversationId,
      fragment,
    };
    let next;
    const kind = workspaceFileKind({ path, name: source.name, type: file?.type });
    if (kind === 'pdf') next = await openContinuousPdfPreview(source, { onAttachFile, onPdfField });
    else if (kind === 'markdown' || kind === 'text') {
      next = await openTextPreview(source, {
        markdownOptions, kind, onAttachFile, onAddMarkdownToNotes, onTextExcerpt,
      });
    } else if (kind === 'image') next = await openImagePreview(source, onAttachFile);
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

async function openTextPreview(source, {
  markdownOptions,
  kind = workspaceFileKind(source),
  onAttachFile,
  onAddMarkdownToNotes,
  onTextExcerpt,
}) {
  const text = await source.file.text();
  const shell = document.createElement('aside');
  shell.className = 'tag-note-hover-preview note-window ai-workspace-preview ai-text-file-preview';
  shell.setAttribute('role', 'dialog');
  shell.setAttribute('aria-label', `文件预览：${source.name}`);
  shell.innerHTML = `<header class="ai-file-preview-head" data-drag-handle><span data-kind="${kind}">${workspaceFileIcon(kind)}</span><div><strong></strong><small>${kind === 'markdown' ? 'Markdown · 只读' : '纯文本 · 只读'}</small></div><div class="ai-file-preview-actions"><button type="button" data-attach-ai title="附到 AI">${ICON.aiAdd}</button>${kind === 'markdown' ? `<button type="button" data-add-note title="添加到笔记">${ICON.note}</button>` : ''}<button type="button" data-download title="下载">${ICON.download}</button><button type="button" data-close title="关闭">${ICON.close}</button></div></header><div class="tag-note-hover-body ai-file-preview-body"></div>`;
  shell.querySelector('strong').textContent = source.name;
  shell.querySelector('[data-attach-ai]').addEventListener('click', () => attachPreviewFile(source, onAttachFile));
  shell.querySelector('[data-add-note]')?.addEventListener('click', () => {
    const added = onAddMarkdownToNotes({ ...source, text });
    toast(added ? '已添加到游离笔记' : '无法添加到笔记', { type: added ? 'success' : 'error' });
  });
  shell.querySelector('[data-download]').addEventListener('click', () => downloadWorkspaceFile(source.file, source.name));
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
  if (source.fragment) highlightTextFragment(body, source.fragment);
  const selection = bindTextSelectionActions({ shell, body, source, onTextExcerpt });
  applySavedRect(shell, TEXT_RECT_KEY, defaultTextRect());
  const disconnectDrag = bindDrag(shell, shell.querySelector('[data-drag-handle]'), () => saveRect(shell, TEXT_RECT_KEY));
  const observer = observeRect(shell, TEXT_RECT_KEY);
  const close = () => {
    disconnectDrag();
    observer?.disconnect();
    selection.close();
    shell.remove();
  };
  shell.querySelector('[data-close]').addEventListener('click', close);
  return { element: shell, path: source.path, close };
}

async function openImagePreview(source, onAttachFile) {
  const shell = document.createElement('aside');
  shell.className = 'tag-note-hover-preview note-window ai-workspace-preview ai-image-file-preview';
  shell.setAttribute('role', 'dialog');
  shell.setAttribute('aria-label', `图片预览：${source.name}`);
  shell.innerHTML = `<header class="ai-file-preview-head" data-drag-handle><span data-kind="image">${workspaceFileIcon('image')}</span><div><strong></strong><small>图片 · Ctrl + 滚轮缩放 · 只读</small></div><div class="ai-file-preview-actions"><button type="button" data-attach-ai title="附到 AI">${ICON.aiAdd}</button><button type="button" data-download title="下载">${ICON.download}</button><button type="button" data-close title="关闭">${ICON.close}</button></div></header><div class="ai-file-preview-body ai-image-preview-body" title="按住 Ctrl 并滚动滚轮缩放图片"><div class="ai-image-preview-canvas"><img alt=""></div></div>`;
  shell.querySelector('strong').textContent = source.name;
  const image = shell.querySelector('img');
  const detail = shell.querySelector('small');
  const body = shell.querySelector('.ai-image-preview-body');
  const imageCanvas = shell.querySelector('.ai-image-preview-canvas');
  const objectUrl = URL.createObjectURL(source.file);
  let imageZoom = 1;
  let naturalWidth = 0;
  let naturalHeight = 0;
  let closed = false;

  const renderImageScale = (focus = null) => {
    if (!naturalWidth || !naturalHeight || closed) return;
    const inset = 28;
    const availableWidth = Math.max(1, body.clientWidth - inset);
    const availableHeight = Math.max(1, body.clientHeight - inset);
    const fit = Math.min(availableWidth / naturalWidth, availableHeight / naturalHeight, 1);
    const width = Math.max(1, Math.round(naturalWidth * fit * imageZoom));
    const height = Math.max(1, Math.round(naturalHeight * fit * imageZoom));
    image.style.width = `${width}px`;
    image.style.height = `${height}px`;
    imageCanvas.style.width = `${Math.max(body.clientWidth, width + inset)}px`;
    imageCanvas.style.height = `${Math.max(body.clientHeight, height + inset)}px`;
    detail.textContent = `图片 · ${naturalWidth} × ${naturalHeight} · ${Math.round(imageZoom * 100)}% · 只读`;
    if (focus) {
      body.scrollLeft = Math.max(0, focus.ratioX * body.scrollWidth - focus.x);
      body.scrollTop = Math.max(0, focus.ratioY * body.scrollHeight - focus.y);
    }
  };

  const onWheelZoom = (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const rect = body.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const focus = {
      x,
      y,
      ratioX: (body.scrollLeft + x) / Math.max(1, body.scrollWidth),
      ratioY: (body.scrollTop + y) / Math.max(1, body.scrollHeight),
    };
    imageZoom = clamp(imageZoom * Math.exp(-event.deltaY * 0.002), 0.25, 8);
    renderImageScale(focus);
  };

  image.alt = source.name;
  image.addEventListener('load', () => {
    naturalWidth = image.naturalWidth;
    naturalHeight = image.naturalHeight;
    renderImageScale();
  });
  image.src = objectUrl;
  body.addEventListener('wheel', onWheelZoom, { passive: false });
  shell.querySelector('[data-attach-ai]').addEventListener('click', () => attachPreviewFile(source, onAttachFile));
  shell.querySelector('[data-download]').addEventListener('click', () => downloadWorkspaceFile(source.file, source.name));
  document.body.append(shell);
  applySavedRect(shell, TEXT_RECT_KEY, defaultTextRect());
  const disconnectDrag = bindDrag(shell, shell.querySelector('[data-drag-handle]'), () => saveRect(shell, TEXT_RECT_KEY));
  const observer = observeRect(shell, TEXT_RECT_KEY, () => renderImageScale());
  const close = () => {
    if (closed) return;
    closed = true;
    disconnectDrag();
    observer?.disconnect();
    body.removeEventListener('wheel', onWheelZoom);
    URL.revokeObjectURL(objectUrl);
    shell.remove();
  };
  shell.querySelector('[data-close]').addEventListener('click', close);
  return { element: shell, path: source.path, close };
}

async function openContinuousPdfPreview(source, { onAttachFile, onPdfField }) {
  const { createPdfTextLayer, openPdfDocument } = await import('../ai/pdf.js');
  const shell = document.createElement('aside');
  shell.className = 'ai-pdf-preview';
  shell.setAttribute('role', 'dialog');
  shell.setAttribute('aria-label', `PDF 阅读器：${source.name}`);
  shell.innerHTML = `<header class="ai-pdf-preview-head" data-drag-handle><span class="ai-pdf-preview-mark" data-kind="pdf">${workspaceFileIcon('pdf')}</span><div><strong></strong><small>连续 PDF 阅读器 · 滚动翻页 · 双指缩放</small></div><div class="ai-pdf-window-controls"><button type="button" data-attach-ai title="附到 AI">${ICON.aiAdd}</button><button type="button" data-download title="下载">${ICON.download}</button><button type="button" data-close title="关闭">${ICON.close}</button></div></header><div class="ai-pdf-toolbar"><button type="button" data-prev title="上一页">${leftIcon()}</button><form data-page-form><label>第 <input type="number" min="1" value="1" inputmode="numeric"> 页</label><span>/ <b data-page-count>—</b></span></form><button type="button" data-next title="下一页">${rightIcon()}</button><small data-page-status>正在加载…</small></div><div class="ai-pdf-stage" title="滚动连续阅读；Ctrl + 滚轮或双指缩放"><div class="ai-pdf-loading">正在打开 PDF…</div><div class="ai-pdf-pages"></div></div>${edgeResizeHandles()}`;
  shell.querySelector('strong').textContent = source.name;
  document.body.append(shell);
  applySavedRect(shell, PDF_RECT_KEY, defaultPdfRect());

  const selectionBar = document.createElement('div');
  selectionBar.className = 'ai-pdf-selection-actions';
  selectionBar.hidden = true;
  selectionBar.innerHTML = `<button type="button" data-copy-reference>${quoteIcon()}<span>复制引用</span></button><button type="button" data-attach-fragment>${ICON.aiAdd}<span>附到 AI</span></button><button type="button" data-copy-text>${copyIcon()}<span>复制文本</span></button>`;
  document.body.append(selectionBar);

  let documentHandle = null;
  let pageNumber = 1;
  let contentZoom = 1;
  let closed = false;
  let zoomTimer = 0;
  let scrollFrame = 0;
  let pageObserver = null;
  let selectionSnapshot = null;
  let pinch = null;
  const pointers = new Map();
  const pageStates = new Map();
  const stage = shell.querySelector('.ai-pdf-stage');
  const pagesElement = shell.querySelector('.ai-pdf-pages');
  const status = shell.querySelector('[data-page-status]');
  const pageInput = shell.querySelector('[data-page-form] input');
  const previous = shell.querySelector('[data-prev]');
  const next = shell.querySelector('[data-next]');

  const updateControls = () => {
    pageInput.value = String(pageNumber);
    previous.disabled = pageNumber <= 1;
    next.disabled = pageNumber >= (documentHandle?.numPages || 1);
    status.textContent = `第 ${pageNumber} 页 · ${Math.round(contentZoom * 100)}%`;
  };
  const hideSelection = ({ clear = false } = {}) => {
    selectionBar.hidden = true;
    selectionSnapshot = null;
    if (clear) window.getSelection()?.removeAllRanges();
  };
  const createPageState = (number) => {
    const element = document.createElement('section');
    element.className = 'ai-pdf-page';
    element.dataset.page = String(number);
    element.setAttribute('aria-label', `第 ${number} 页`);
    element.innerHTML = `<canvas></canvas><div class="textLayer"></div><div class="ai-pdf-fragment-layer"></div><small class="ai-pdf-page-number">${number}</small><div class="ai-pdf-page-loading">正在加载第 ${number} 页…</div>`;
    pagesElement.append(element);
    const state = {
      number, element,
      canvas: element.querySelector('canvas'),
      textLayerElement: element.querySelector('.textLayer'),
      highlightLayer: element.querySelector('.ai-pdf-fragment-layer'),
      page: null, pagePromise: null, renderTask: null, textLayer: null, renderId: 0, rendered: false,
    };
    pageStates.set(number, state);
    return state;
  };
  const renderFragmentHighlight = (state) => {
    state.highlightLayer.replaceChildren();
    const fragment = source.fragment;
    if (!fragment || fragment.format !== 'pdf' || Number(fragment.page) !== state.number) return;
    for (const rect of fragment.rects || []) {
      const mark = document.createElement('span');
      mark.className = 'ai-pdf-fragment-highlight';
      mark.style.left = `${rect.x * 100}%`;
      mark.style.top = `${rect.y * 100}%`;
      mark.style.width = `${rect.width * 100}%`;
      mark.style.height = `${rect.height * 100}%`;
      state.highlightLayer.append(mark);
    }
  };
  const renderPage = async (number, { force = false } = {}) => {
    const state = pageStates.get(number);
    if (!state || closed || (state.rendered && !force)) return state;
    const renderId = ++state.renderId;
    state.renderTask?.cancel?.();
    state.textLayer?.cancel?.();
    state.page ||= await (state.pagePromise ||= documentHandle.getPage(number));
    if (closed || renderId !== state.renderId) return state;
    const base = state.page.getViewport({ scale: 1 });
    const availableWidth = Math.max(220, stage.clientWidth - 30);
    const viewport = state.page.getViewport({ scale: (availableWidth / base.width) * contentZoom });
    const ratio = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    state.canvas.width = Math.floor(viewport.width * ratio);
    state.canvas.height = Math.floor(viewport.height * ratio);
    state.canvas.style.width = `${Math.floor(viewport.width)}px`;
    state.canvas.style.height = `${Math.floor(viewport.height)}px`;
    state.element.style.width = `${Math.floor(viewport.width)}px`;
    state.element.style.height = `${Math.floor(viewport.height)}px`;
    state.element.style.minHeight = '0px';
    state.element.style.setProperty('--scale-factor', String(viewport.scale));
    state.textLayerElement.replaceChildren();
    state.textLayerElement.style.width = `${Math.floor(viewport.width)}px`;
    state.textLayerElement.style.height = `${Math.floor(viewport.height)}px`;
    state.renderTask = state.page.render({
      canvas: state.canvas,
      canvasContext: state.canvas.getContext('2d', { alpha: false }),
      viewport,
      transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
    });
    state.textLayer = createPdfTextLayer({
      textContentSource: state.page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
      container: state.textLayerElement,
      viewport,
    });
    try {
      await Promise.all([state.renderTask.promise, state.textLayer.render()]);
      if (closed || renderId !== state.renderId) return state;
      state.rendered = true;
      state.element.querySelector('.ai-pdf-page-loading').hidden = true;
      renderFragmentHighlight(state);
    } catch (error) {
      if (error?.name !== 'RenderingCancelledException' && !closed) throw error;
    }
    return state;
  };
  const goToPage = async (value, { behavior = 'smooth' } = {}) => {
    if (!documentHandle) return;
    pageNumber = clamp(Math.round(Number(value) || 1), 1, documentHandle.numPages);
    updateControls();
    const state = await renderPage(pageNumber);
    state?.element?.scrollIntoView?.({ behavior, block: 'start' });
  };
  const updateSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) { hideSelection(); return; }
    const anchor = (selection.anchorNode?.parentElement || selection.anchorNode)?.closest?.('.ai-pdf-page');
    const focus = (selection.focusNode?.parentElement || selection.focusNode)?.closest?.('.ai-pdf-page');
    if (!anchor || anchor !== focus) { hideSelection(); return; }
    const text = selection.toString().replace(/\s+/g, ' ').trim();
    if (!text) { hideSelection(); return; }
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const pageRect = anchor.getBoundingClientRect();
    const rects = [...range.getClientRects()].filter((item) => item.width > 0 && item.height > 0).map((item) => ({
      x: (item.left - pageRect.left) / pageRect.width,
      y: (item.top - pageRect.top) / pageRect.height,
      width: item.width / pageRect.width,
      height: item.height / pageRect.height,
    }));
    selectionSnapshot = { page: Number(anchor.dataset.page) || 1, text, rects };
    selectionBar.style.left = `${Math.round(clamp(rect.left, 8, innerWidth - 330))}px`;
    selectionBar.style.top = `${Math.round(rect.top > 54 ? rect.top - 42 : rect.bottom + 8)}px`;
    selectionBar.hidden = false;
  };
  const rerenderLoadedPages = async (focus = null) => {
    hideSelection({ clear: true });
    const oldWidth = Math.max(1, stage.scrollWidth);
    const oldHeight = Math.max(1, stage.scrollHeight);
    const ratioX = focus ? (stage.scrollLeft + focus.x) / oldWidth : 0;
    const ratioY = focus ? (stage.scrollTop + focus.y) / oldHeight : 0;
    await Promise.all([...pageStates.values()].filter((state) => state.rendered || state.number === pageNumber)
      .map((state) => renderPage(state.number, { force: true })));
    if (focus) {
      stage.scrollLeft = Math.max(0, ratioX * stage.scrollWidth - focus.x);
      stage.scrollTop = Math.max(0, ratioY * stage.scrollHeight - focus.y);
    }
    updateControls();
  };
  const scheduleZoomRender = (focus) => {
    updateControls();
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => rerenderLoadedPages(focus).catch((error) => {
      status.textContent = error?.message || '页面渲染失败';
    }), 70);
  };
  const onWheelZoom = (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const rect = stage.getBoundingClientRect();
    const focus = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    contentZoom = clamp(contentZoom * Math.exp(-event.deltaY * 0.002), 0.5, 4);
    scheduleZoomRender(focus);
  };
  const syncCurrentPage = () => {
    scrollFrame = 0;
    const stageRect = stage.getBoundingClientRect();
    const center = stageRect.top + stage.clientHeight / 2;
    let best = pageNumber;
    let distance = Infinity;
    for (const state of pageStates.values()) {
      const rect = state.element.getBoundingClientRect();
      const candidate = Math.abs(rect.top + rect.height / 2 - center);
      if (candidate < distance) { distance = candidate; best = state.number; }
    }
    if (best !== pageNumber) { pageNumber = best; updateControls(); }
  };
  const onStageScroll = () => {
    if (!scrollFrame) scrollFrame = requestAnimationFrame(syncCurrentPage);
    if (!selectionBar.hidden) updateSelection();
  };
  const pointerDistance = () => {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  const pointerCenter = () => {
    const [a, b] = [...pointers.values()];
    return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : { x: 0, y: 0 };
  };
  const onPointerDown = (event) => {
    if (event.pointerType !== 'touch') return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    stage.setPointerCapture?.(event.pointerId);
    if (pointers.size === 2) {
      const center = pointerCenter();
      const rect = stage.getBoundingClientRect();
      pinch = {
        distance: pointerDistance(), zoom: contentZoom, scale: 1,
        focus: { x: center.x - rect.left, y: center.y - rect.top },
      };
      hideSelection({ clear: true });
    }
  };
  const onPointerMove = (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!pinch || pointers.size < 2) return;
    event.preventDefault();
    pinch.scale = clamp(pointerDistance() / Math.max(1, pinch.distance), 0.5, 4);
    const center = pointerCenter();
    const rect = stage.getBoundingClientRect();
    pagesElement.style.transformOrigin = `${center.x - rect.left + stage.scrollLeft}px ${center.y - rect.top + stage.scrollTop}px`;
    pagesElement.style.transform = `scale(${pinch.scale})`;
    status.textContent = `第 ${pageNumber} 页 · ${Math.round(clamp(pinch.zoom * pinch.scale, 0.5, 4) * 100)}%`;
  };
  const finishPointer = async (event) => {
    pointers.delete(event.pointerId);
    if (!pinch || pointers.size >= 2) return;
    const finished = pinch;
    pinch = null;
    pagesElement.style.removeProperty('transform');
    pagesElement.style.removeProperty('transform-origin');
    contentZoom = clamp(finished.zoom * finished.scale, 0.5, 4);
    await rerenderLoadedPages(finished.focus);
  };

  previous.addEventListener('click', () => goToPage(pageNumber - 1));
  next.addEventListener('click', () => goToPage(pageNumber + 1));
  shell.querySelector('[data-page-form]').addEventListener('submit', (event) => { event.preventDefault(); goToPage(pageInput.value); });
  shell.querySelector('[data-attach-ai]').addEventListener('click', () => attachPreviewFile(source, onAttachFile));
  shell.querySelector('[data-download]').addEventListener('click', () => downloadWorkspaceFile(source.file, source.name));
  shell.querySelector('[data-close]').addEventListener('click', () => close());
  stage.addEventListener('wheel', onWheelZoom, { passive: false });
  stage.addEventListener('scroll', onStageScroll, { passive: true });
  stage.addEventListener('pointerup', () => setTimeout(updateSelection, 0));
  stage.addEventListener('keyup', () => setTimeout(updateSelection, 0));
  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerup', finishPointer);
  stage.addEventListener('pointercancel', finishPointer);
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
  const selectedReference = () => fileFragmentReference({ ...source, ...selectionSnapshot, format: 'pdf' });
  selectionBar.querySelector('[data-copy-reference]').addEventListener('click', async () => {
    if (!selectionSnapshot?.text) return;
    const copied = await writeGraphReference(selectedReference());
    toast(copied ? '已复制片段引用' : '复制失败', { type: copied ? 'success' : 'error' });
  });
  selectionBar.querySelector('[data-attach-fragment]').addEventListener('click', () => {
    if (!selectionSnapshot?.text) return;
    const attached = onPdfField({ ...source, ...selectionSnapshot });
    toast(attached ? '已添加片段引用' : '该 PDF 不属于当前对话', { type: attached ? 'success' : 'error' });
    if (attached) hideSelection({ clear: true });
  });

  const disconnectDrag = bindDrag(shell, shell.querySelector('[data-drag-handle]'), () => {
    hideSelection();
    saveRect(shell, PDF_RECT_KEY);
  });
  const disconnectEdgeResize = bindEdgeResize(shell, () => {
    saveRect(shell, PDF_RECT_KEY);
    rerenderLoadedPages().catch(() => {});
  });
  const onWindowResize = () => { clampWindow(shell); rerenderLoadedPages().catch(() => {}); };
  window.addEventListener('resize', onWindowResize);
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(zoomTimer);
    cancelAnimationFrame(scrollFrame);
    pageObserver?.disconnect?.();
    for (const state of pageStates.values()) {
      state.renderTask?.cancel?.();
      state.textLayer?.cancel?.();
    }
    documentHandle?.destroy?.();
    disconnectDrag();
    disconnectEdgeResize();
    stage.removeEventListener('wheel', onWheelZoom);
    stage.removeEventListener('scroll', onStageScroll);
    stage.removeEventListener('pointerdown', onPointerDown);
    stage.removeEventListener('pointermove', onPointerMove);
    stage.removeEventListener('pointerup', finishPointer);
    stage.removeEventListener('pointercancel', finishPointer);
    window.removeEventListener('resize', onWindowResize);
    selectionBar.remove();
    shell.remove();
  };

  try {
    documentHandle = await openPdfDocument(source.file);
    if (closed) return { element: shell, path: source.path, close };
    shell.querySelector('[data-page-count]').textContent = String(documentHandle.numPages);
    pageInput.max = String(documentHandle.numPages);
    for (let number = 1; number <= documentHandle.numPages; number += 1) createPageState(number);
    shell.querySelector('.ai-pdf-loading').hidden = true;
    const targetPage = clamp(Math.round(Number(source.fragment?.page) || 1), 1, documentHandle.numPages);
    pageNumber = targetPage;
    updateControls();
    if (window.IntersectionObserver) {
      pageObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) renderPage(Number(entry.target.dataset.page)).catch(() => {});
        }
      }, { root: stage, rootMargin: '120% 0px' });
      for (const state of pageStates.values()) pageObserver.observe(state.element);
      await renderPage(targetPage);
    } else {
      await Promise.all([...pageStates.keys()].map((number) => renderPage(number)));
    }
    if (source.fragment) await goToPage(targetPage, { behavior: 'auto' });
  } catch (error) {
    close();
    throw error;
  }
  return { element: shell, path: source.path, close };
}

async function openPdfPreview(source, { onAttachFile, onPdfField }) {
  const { createPdfTextLayer, openPdfDocument } = await import('../ai/pdf.js');
  const shell = document.createElement('aside');
  shell.className = 'ai-pdf-preview';
  shell.setAttribute('role', 'dialog');
  shell.setAttribute('aria-label', `PDF 阅读器：${source.name}`);
  shell.innerHTML = `<header class="ai-pdf-preview-head" data-drag-handle><span class="ai-pdf-preview-mark" data-kind="pdf">${workspaceFileIcon('pdf')}</span><div><strong></strong><small>PDF 阅读器 · Ctrl + 滚轮缩放</small></div><div class="ai-pdf-window-controls"><button type="button" data-attach-ai title="附到 AI">${ICON.aiAdd}</button><button type="button" data-download title="下载">${ICON.download}</button><button type="button" data-close title="关闭">${ICON.close}</button></div></header><div class="ai-pdf-toolbar"><button type="button" data-prev title="上一页">${leftIcon()}</button><form data-page-form><label>第 <input type="number" min="1" value="1" inputmode="numeric"> 页</label><span>/ <b data-page-count>—</b></span></form><button type="button" data-next title="下一页">${rightIcon()}</button><small data-page-status>正在加载…</small></div><div class="ai-pdf-stage" title="按住 Ctrl 并滚动滚轮缩放 PDF 内容"><div class="ai-pdf-loading">正在打开 PDF…</div><div class="ai-pdf-page" hidden><canvas></canvas><div class="textLayer"></div></div></div>${edgeResizeHandles()}`;
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
  let zoomTimer = 0;
  let contentZoom = 1;
  let zoomFocus = null;
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
    status.textContent = `第 ${pageNumber} 页 · ${Math.round(contentZoom * 100)}%`;
    pageInput.value = String(pageNumber);
    previous.disabled = pageNumber <= 1;
    next.disabled = pageNumber >= documentHandle.numPages;
    const page = await documentHandle.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(220, stage.clientWidth - 30);
    const viewport = page.getViewport({ scale: (availableWidth / base.width) * contentZoom });
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
      status.textContent = `第 ${pageNumber} 页 · ${Math.round(contentZoom * 100)}%`;
      if (zoomFocus) {
        stage.scrollLeft = Math.max(0, zoomFocus.ratioX * stage.scrollWidth - zoomFocus.x);
        stage.scrollTop = Math.max(0, zoomFocus.ratioY * stage.scrollHeight - zoomFocus.y);
        zoomFocus = null;
      }
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

  const onWheelZoom = (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const rect = stage.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    zoomFocus = {
      x,
      y,
      ratioX: (stage.scrollLeft + x) / Math.max(1, stage.scrollWidth),
      ratioY: (stage.scrollTop + y) / Math.max(1, stage.scrollHeight),
    };
    contentZoom = clamp(contentZoom * Math.exp(-event.deltaY * 0.002), 0.5, 4);
    status.textContent = `第 ${pageNumber} 页 · ${Math.round(contentZoom * 100)}%`;
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => renderPage().catch((error) => {
      status.textContent = error?.message || '页面渲染失败';
    }), 60);
  };

  previous.addEventListener('click', () => goToPage(pageNumber - 1));
  next.addEventListener('click', () => goToPage(pageNumber + 1));
  shell.querySelector('[data-page-form]').addEventListener('submit', (event) => { event.preventDefault(); goToPage(pageInput.value); });
  shell.querySelector('[data-attach-ai]').addEventListener('click', () => attachPreviewFile(source, onAttachFile));
  shell.querySelector('[data-download]').addEventListener('click', () => downloadWorkspaceFile(source.file, source.name));
  shell.querySelector('[data-close]').addEventListener('click', () => close());
  stage.addEventListener('wheel', onWheelZoom, { passive: false });
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
  const disconnectEdgeResize = bindEdgeResize(shell, () => {
    saveRect(shell, PDF_RECT_KEY);
    renderPage().catch(() => {});
  });
  const onWindowResize = () => { clampWindow(shell); renderPage().catch(() => {}); };
  window.addEventListener('resize', onWindowResize);

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(zoomTimer);
    renderTask?.cancel?.();
    textLayer?.cancel?.();
    documentHandle?.destroy?.();
    disconnectDrag();
    disconnectEdgeResize();
    stage.removeEventListener('wheel', onWheelZoom);
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

function attachPreviewFile(source, onAttachFile) {
  const attached = onAttachFile(source);
  toast(attached ? '文件已附到 AI' : '无法附到 AI', { type: attached ? 'success' : 'error' });
  return attached;
}

function bindTextSelectionActions({ shell, body, source, onTextExcerpt }) {
  const selectionBar = document.createElement('div');
  selectionBar.className = 'ai-file-selection-actions';
  selectionBar.hidden = true;
  selectionBar.innerHTML = `<button type="button" data-copy-reference>${quoteIcon()}<span>复制引用</span></button><button type="button" data-attach-fragment>${ICON.aiAdd}<span>附到 AI</span></button><button type="button" data-copy-text>${copyIcon()}<span>复制文本</span></button>`;
  document.body.append(selectionBar);
  let snapshot = null;
  const hide = ({ clear = false } = {}) => {
    selectionBar.hidden = true;
    snapshot = null;
    if (clear) window.getSelection()?.removeAllRanges();
  };
  const update = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) { hide(); return; }
    const anchor = selection.anchorNode?.parentElement || selection.anchorNode;
    const focus = selection.focusNode?.parentElement || selection.focusNode;
    if (!body.contains(anchor) || !body.contains(focus)) { hide(); return; }
    const selected = selection.toString().trim();
    if (!selected) { hide(); return; }
    const visibleText = body.innerText || body.textContent || '';
    const found = visibleText.indexOf(selected);
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect?.() || { left: 8, top: 8, bottom: 38 };
    snapshot = {
      text: selected,
      start: found >= 0 ? found : null,
      end: found >= 0 ? found + selected.length : null,
      before: found >= 0 ? visibleText.slice(Math.max(0, found - 320), found) : '',
      after: found >= 0 ? visibleText.slice(found + selected.length, found + selected.length + 480) : '',
    };
    selectionBar.style.left = `${Math.round(clamp(rect.left, 8, innerWidth - 240))}px`;
    selectionBar.style.top = `${Math.round(rect.top > 54 ? rect.top - 42 : rect.bottom + 8)}px`;
    selectionBar.hidden = false;
  };
  const scheduleUpdate = () => setTimeout(update, 0);
  body.addEventListener('pointerup', scheduleUpdate);
  body.addEventListener('keyup', scheduleUpdate);
  body.addEventListener('scroll', update, { passive: true });
  for (const button of selectionBar.querySelectorAll('button')) button.addEventListener('pointerdown', (event) => event.preventDefault());
  selectionBar.querySelector('[data-copy-text]').addEventListener('click', async () => {
    if (!snapshot?.text) return;
    await writePlainText(snapshot.text);
    toast('已复制纯文本');
  });
  const reference = () => fileFragmentReference({
    ...source,
    ...snapshot,
    format: workspaceFileKind(source),
  });
  selectionBar.querySelector('[data-copy-reference]').addEventListener('click', async () => {
    if (!snapshot?.text) return;
    const copied = await writeGraphReference(reference());
    toast(copied ? '已复制片段引用' : '复制失败', { type: copied ? 'success' : 'error' });
  });
  selectionBar.querySelector('[data-attach-fragment]').addEventListener('click', () => {
    if (!snapshot?.text) return;
    const attached = onTextExcerpt({ ...source, ...snapshot, format: workspaceFileKind(source) });
    toast(attached ? '已添加片段引用' : '该文件不属于当前对话', { type: attached ? 'success' : 'error' });
    if (attached) hide({ clear: true });
  });
  return {
    close() {
      body.removeEventListener('pointerup', scheduleUpdate);
      body.removeEventListener('keyup', scheduleUpdate);
      body.removeEventListener('scroll', update);
      selectionBar.remove();
    },
  };
}

export function highlightTextFragment(root, fragment) {
  if (!root || !fragment?.text) return null;
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest('script, style, .file-fragment-highlight')
      ? NodeFilter.FILTER_REJECT
      : NodeFilter.FILTER_ACCEPT,
  });
  let fullText = '';
  while (walker.nextNode()) {
    nodes.push({ node: walker.currentNode, start: fullText.length, end: fullText.length + walker.currentNode.data.length });
    fullText += walker.currentNode.data;
  }
  let start = Number.isFinite(fragment.start) ? fragment.start : fullText.indexOf(String(fragment.text));
  if (start < 0 || fullText.slice(start, start + String(fragment.text).length) !== String(fragment.text)) {
    start = fullText.indexOf(String(fragment.text));
  }
  if (start < 0) return null;
  const end = Math.min(fullText.length, start + String(fragment.text).length);
  const pieces = [];
  for (const item of nodes.filter((item) => item.end > start && item.start < end).reverse()) {
    const localStart = Math.max(0, start - item.start);
    const localEnd = Math.min(item.node.data.length, end - item.start);
    const range = document.createRange();
    range.setStart(item.node, localStart);
    range.setEnd(item.node, localEnd);
    const mark = document.createElement('mark');
    mark.className = 'file-fragment-highlight';
    range.surroundContents(mark);
    pieces.unshift(mark);
  }
  const target = pieces[0] || null;
  requestAnimationFrame(() => target?.scrollIntoView?.({ behavior: 'smooth', block: 'center' }));
  return target;
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

function bindEdgeResize(element, onEnd = () => {}) {
  let start = null;
  const handles = [...element.querySelectorAll('[data-resize-edge]')];
  const move = (event) => {
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    let { left, top, right, bottom } = start;
    if (start.edge.includes('e')) right = clamp(start.right + dx, left + 360, innerWidth - 8);
    if (start.edge.includes('s')) bottom = clamp(start.bottom + dy, top + 420, innerHeight - 8);
    if (start.edge.includes('w')) left = clamp(start.left + dx, 8, right - 360);
    if (start.edge.includes('n')) top = clamp(start.top + dy, 8, bottom - 420);
    element.style.left = `${Math.round(left)}px`;
    element.style.top = `${Math.round(top)}px`;
    element.style.width = `${Math.round(right - left)}px`;
    element.style.height = `${Math.round(bottom - top)}px`;
  };
  const up = () => {
    if (!start) return;
    start = null;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    onEnd();
  };
  const down = (event) => {
    if (event.button !== 0) return;
    const rect = element.getBoundingClientRect();
    start = {
      edge: event.currentTarget.dataset.resizeEdge,
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    event.preventDefault();
  };
  handles.forEach((handle) => handle.addEventListener('pointerdown', down));
  return () => {
    handles.forEach((handle) => handle.removeEventListener('pointerdown', down));
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    start = null;
  };
}

function observeRect(element, key, onResize = () => {}) {
  if (!window.ResizeObserver) return null;
  let timer = 0;
  const observer = new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      clampWindow(element);
      saveRect(element, key);
      onResize();
    }, 120);
  });
  const disconnect = observer.disconnect.bind(observer);
  observer.disconnect = () => {
    clearTimeout(timer);
    disconnect();
  };
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

function fileTypeSvg(content) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${content}</svg>`;
}

function edgeResizeHandles() {
  return ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw']
    .map((edge) => `<span class="ai-window-resize-edge is-${edge}" data-resize-edge="${edge}" aria-hidden="true"></span>`)
    .join('');
}

function leftIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 5.5L8 10l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
function rightIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 5.5L12 10l-4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
function quoteIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 5.5h4v4a4 4 0 01-3.7 4M11.5 5.5h4v4a4 4 0 01-3.7 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'; }
function copyIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M13 7V5.5A1.5 1.5 0 0011.5 4h-7A1.5 1.5 0 003 5.5v7A1.5 1.5 0 004.5 14H7" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>'; }
