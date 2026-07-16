import { noteDisplayTitle, removeNote } from '../data/notes.js';
import { graphReferenceToMember, resolveTagNoteReference } from '../data/graphReference.js';
import { renderMarkdownInto } from '../render/markdown.js';
import { ICON } from './icons.js';
import { confirmDialog, toast } from './feedback.js';

const SIZE_KEY = 'paper-graph:note-window-size';
const DEFAULT_SIZE = { width: 380, height: 440 };
const PREVIEW_MIN_SIZE = { width: 300, height: 220 };
const EDITOR_MIN_SIZE = { width: 430, height: 300 };
const usesCompactNoteLayout = () => window.matchMedia?.('(max-width: 760px)').matches;
const supportsHover = () => !window.matchMedia || window.matchMedia('(hover: hover) and (pointer: fine)').matches;

export function createNoteWindowController(ctx) {
  let closeTimer = null;
  let preview = null;
  let lastPosition = null;

  const minimumSize = (element) => element?.classList?.contains('tag-note-editor') ? EDITOR_MIN_SIZE : PREVIEW_MIN_SIZE;
  const readSize = (element) => {
    const minimum = minimumSize(element);
    const minWidth = Math.min(minimum.width, Math.max(120, window.innerWidth - 16));
    const minHeight = Math.min(minimum.height, Math.max(140, window.innerHeight - 16));
    const fallbackWidth = Math.max(minWidth, Math.min(DEFAULT_SIZE.width, window.innerWidth - 16));
    const fallbackHeight = Math.max(minHeight, Math.min(DEFAULT_SIZE.height, window.innerHeight - 16));
    try {
      const value = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null');
      return {
        width: clamp(value?.width, minWidth, Math.max(minWidth, window.innerWidth - 16), fallbackWidth),
        height: clamp(value?.height, minHeight, Math.max(minHeight, window.innerHeight - 16), fallbackHeight),
      };
    } catch { return { width: fallbackWidth, height: fallbackHeight }; }
  };
  const saveSize = (element) => {
    if (usesCompactNoteLayout()) return;
    const rect = element?.getBoundingClientRect?.();
    if (!rect?.width || !rect?.height) return;
    localStorage.setItem(SIZE_KEY, JSON.stringify({ width: Math.round(rect.width), height: Math.round(rect.height) }));
  };
  const applySize = (element) => {
    if (usesCompactNoteLayout()) {
      element.style.removeProperty('width');
      element.style.removeProperty('height');
      return;
    }
    const size = readSize(element);
    element.style.width = `${Math.min(size.width, window.innerWidth - 16)}px`;
    element.style.height = `${Math.min(size.height, window.innerHeight - 16)}px`;
  };
  const position = (element, anchor) => {
    if (usesCompactNoteLayout()) {
      element.style.left = '8px';
      element.style.top = '8px';
      lastPosition = { left: 8, top: 8 };
      return lastPosition;
    }
    const anchorElement = anchor?.closest?.('.note-ui-row, .m-menu-item, .tag-note-row') || anchor;
    const r = anchorElement?.getBoundingClientRect?.() || { left: 8, right: 8, top: 8, bottom: 8 };
    const box = element.getBoundingClientRect();
    let left = r.right + 8;
    if (left + box.width > window.innerWidth - 8) left = r.left - box.width - 8;
    if (left < 8) left = Math.max(8, Math.min(r.right + 8, window.innerWidth - box.width - 8));
    let top = Math.max(8, Math.min(r.top, window.innerHeight - box.height - 8));
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    lastPosition = { left, top };
    return lastPosition;
  };
  const clampPosition = (element, preferred = lastPosition) => {
    if (usesCompactNoteLayout()) {
      element.style.left = '8px';
      element.style.top = '8px';
      lastPosition = { left: 8, top: 8 };
      return lastPosition;
    }
    const box = element.getBoundingClientRect();
    const left = Math.max(8, Math.min(preferred?.left ?? box.left ?? 8, window.innerWidth - box.width - 8));
    const top = Math.max(8, Math.min(preferred?.top ?? box.top ?? 8, window.innerHeight - box.height - 8));
    element.style.left = `${left}px`; element.style.top = `${top}px`;
    lastPosition = { left, top };
    return lastPosition;
  };
  const observeSize = (element) => {
    if (usesCompactNoteLayout()) return () => {};
    if (!window.ResizeObserver) return () => {};
    const observer = new ResizeObserver(() => { saveSize(element); clampPosition(element); });
    observer.observe(element);
    return () => observer.disconnect();
  };
  const attachEdgeResize = (element) => {
    if (usesCompactNoteLayout()) return () => {};
    const cleanups = [];
    for (const direction of ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw']) {
      const handle = document.createElement('span');
      handle.className = `note-resize-handle note-resize-${direction}`;
      handle.setAttribute('aria-hidden', 'true');
      element.appendChild(handle);
      let start = null;
      const down = (event) => {
        if (event.button !== 0) return;
        const rect = element.getBoundingClientRect();
        start = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
        handle.setPointerCapture?.(event.pointerId); event.preventDefault(); event.stopPropagation();
      };
      const move = (event) => {
        if (!start) return;
        const dx = event.clientX - start.x; const dy = event.clientY - start.y;
        let left = start.left; let top = start.top; let width = start.width; let height = start.height;
        const minimum = minimumSize(element);
        const minWidth = Math.min(minimum.width, Math.max(120, window.innerWidth - 16));
        const minHeight = Math.min(minimum.height, Math.max(140, window.innerHeight - 16));
        if (direction.includes('e')) width = clamp(start.width + dx, minWidth, window.innerWidth - start.left - 8, start.width);
        if (direction.includes('s')) height = clamp(start.height + dy, minHeight, window.innerHeight - start.top - 8, start.height);
        if (direction.includes('w')) { width = clamp(start.width - dx, minWidth, start.right - 8, start.width); left = start.right - width; }
        if (direction.includes('n')) { height = clamp(start.height - dy, minHeight, start.bottom - 8, start.height); top = start.bottom - height; }
        element.style.width = `${width}px`; element.style.height = `${height}px`;
        element.style.left = `${left}px`; element.style.top = `${top}px`;
        lastPosition = { left, top };
      };
      const up = () => { if (!start) return; start = null; saveSize(element); clampPosition(element); };
      handle.addEventListener('pointerdown', down); handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
      cleanups.push(() => { handle.removeEventListener('pointerdown', down); handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); handle.remove(); });
    }
    return () => cleanups.forEach((cleanup) => cleanup());
  };
  const close = () => {
    clearTimeout(closeTimer); closeTimer = null;
    preview?._disconnectSize?.(); preview?._disconnectEdges?.();
    preview?.remove(); preview = null;
  };
  const scheduleClose = () => {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(close, 260);
  };
  const show = (note, anchor) => {
    clearTimeout(closeTimer);
    close();
    const panel = document.createElement('aside');
    panel.className = 'tag-note-hover-preview note-window';
    const title = document.createElement('header'); title.textContent = noteDisplayTitle(note);
    const body = document.createElement('div'); body.className = 'tag-note-hover-body ai-markdown';
    panel.append(title, body);
    panel.addEventListener('pointerenter', () => clearTimeout(closeTimer));
    panel.addEventListener('pointerleave', scheduleClose);
    document.body.appendChild(panel);
    applySize(panel);
    position(panel, anchor);
    panel._disconnectSize = observeSize(panel);
    panel._disconnectEdges = attachEdgeResize(panel);
    renderMarkdownInto(body, note.content || '*空笔记*', {
      macros: ctx.model?.meta?.macros,
      graphLabels: ctx.model?.labelIndex,
      onGraphReference: (reference) => {
        const noteRef = resolveTagNoteReference(reference, ctx.graph?.getTags?.() || [], ctx.getNotes?.() || []);
        if (noteRef) { ctx.openNoteEditor?.(noteRef.note.id, { anchor: panel }); return; }
        const member = graphReferenceToMember(reference, ctx.graph?.getTags?.() || [], ctx.getNotes?.() || []);
        if (member) ctx.jumpToMember?.(member);
      },
    });
    preview = panel;
    return panel;
  };
  return {
    show, close, scheduleClose, applySize, saveSize, observeSize, attachEdgeResize, position, clampPosition,
    contains(target) { return !!preview?.contains?.(target); },
    get lastPosition() { return lastPosition; },
  };
}

export function createNoteRow(ctx, note, { className = '', showDelete = true } = {}) {
  const row = document.createElement('div');
  row.className = `note-ui-row${className ? ` ${className}` : ''}`;
  row.dataset.noteId = String(note.id || '');
  const label = document.createElement('span'); label.className = 'note-ui-title'; label.textContent = noteDisplayTitle(note);
  const actions = document.createElement('span'); actions.className = 'note-ui-actions';
  const button = (icon, title, onClick, className = '') => {
    const element = document.createElement('button'); element.type = 'button'; element.className = `note-ui-action${className ? ` ${className}` : ''}`;
    element.title = title; element.innerHTML = ICON[icon] || '';
    element.addEventListener('click', (event) => { event.stopPropagation(); onClick(element); });
    actions.appendChild(element); return element;
  };
  button('aiAdd', '引用到 AI', () => {
    const attached = ctx.aiPanel?.attachNote?.(note) ?? ctx.aiPanel?.attachTagNote?.(null, null, note);
    toast(attached ? '笔记已附到 AI' : '无法附到 AI', attached ? {} : { type: 'error' });
  }, 'note-ui-ai');
  button('edit', '编辑笔记', () => { ctx.noteWindows?.close(); ctx.openNoteEditor?.(note.id, { anchor: row }); ctx.closeTagInstanceMenu?.(); }, 'note-ui-edit');
  if (showDelete) button('trash', '删除笔记', async () => {
    const ok = await confirmDialog({ title: '删除笔记', message: `删除「${noteDisplayTitle(note)}」？`, okText: '删除', danger: true });
    if (ok) { ctx.closeTagInstanceMenu?.(); ctx.persistNotes?.(removeNote(ctx.getNotes?.() || [], note.id)); }
  }, 'note-ui-delete');
  row.append(label, actions);
  row.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    ctx.noteWindows?.close();
    ctx.openNoteEditor?.(note.id, { anchor: row, mode: 'preview' });
    ctx.closeTagInstanceMenu?.();
  });
  if (supportsHover()) {
    row.addEventListener('pointerenter', () => ctx.noteWindows?.show(note, row));
    row.addEventListener('pointerleave', () => ctx.noteWindows?.scheduleClose());
  }
  return row;
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}
