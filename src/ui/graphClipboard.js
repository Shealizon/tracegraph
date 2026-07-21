import { graphReferenceHref, graphReferenceMarkdown } from '../data/graphReference.js';
import {
  fileFragmentReferenceHref,
  fileFragmentReferenceMarkdown,
  isFileFragmentReference,
} from '../data/fileReference.js';

export const GRAPH_REFERENCE_MIME = 'application/x-tracegraph-reference';
const GRAPH_REFERENCE_WEB_MIME = `web ${GRAPH_REFERENCE_MIME}`;

export function setGraphReferenceClipboardData(data, reference) {
  if (!data || !reference) return false;
  const json = JSON.stringify(reference);
  data.setData('text/plain', reference.text || reference.label || reference.nodeId || reference.path || '');
  data.setData(GRAPH_REFERENCE_MIME, json);
  data.setData('text/html', graphReferenceHtml(reference));
  return true;
}

export async function writeGraphReference(reference) {
  if (!reference) return false;
  const plain = reference.text || reference.label || reference.nodeId || reference.path || '';
  // 在用户点击产生的同步 copy 事件中写入多格式数据，避免
  // navigator.clipboard.write(ClipboardItem) 触发浏览器的网站剪贴板授权框。
  if (writeGraphReferenceWithCopyEvent(reference)) return true;
  return copyPlainTextWithoutPermission(plain);
}

export async function writePlainText(value) {
  const text = String(value || '');
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* use the permission-free fallback */ }
  return copyPlainTextWithoutPermission(text);
}

function writeGraphReferenceWithCopyEvent(reference) {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
  let wrote = false;
  const onCopy = (event) => {
    if (!event.clipboardData) return;
    event.preventDefault();
    wrote = setGraphReferenceClipboardData(event.clipboardData, reference);
  };
  document.addEventListener('copy', onCopy, { capture: true, once: true });
  try {
    const copied = document.execCommand('copy');
    return copied && wrote;
  } catch {
    return false;
  } finally {
    document.removeEventListener('copy', onCopy, true);
  }
}

function copyPlainTextWithoutPermission(text) {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try { return document.execCommand('copy'); }
  catch { return false; }
  finally { textarea.remove(); }
}

export function readGraphReferenceClipboard(data) {
  if (!data) return null;
  for (const type of [GRAPH_REFERENCE_MIME, GRAPH_REFERENCE_WEB_MIME]) {
    const raw = data.getData(type);
    if (!raw) continue;
    try { return JSON.parse(raw); } catch { /* inspect HTML fallback */ }
  }
  const html = data.getData('text/html') || '';
  const match = html.match(/data-tracegraph-reference="([^"]+)"/i);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

export function bindGraphReferencePaste(target, { onReference, insertMarkdown = true } = {}) {
  if (!target) return () => {};
  let plainPaste = false;
  const onKeyDown = (event) => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'v') plainPaste = true;
  };
  const onPaste = (event) => {
    if (plainPaste) { plainPaste = false; return; }
    const reference = readGraphReferenceClipboard(event.clipboardData);
    if (!reference) return;
    event.preventDefault();
    if (insertMarkdown) {
      const markdown = contentReferenceMarkdown(reference);
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? start;
      target.setRangeText(markdown, start, end, 'end');
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
    onReference?.(reference);
  };
  const reset = () => { setTimeout(() => { plainPaste = false; }, 0); };
  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', reset);
  target.addEventListener('paste', onPaste);
  return () => {
    target.removeEventListener('keydown', onKeyDown);
    target.removeEventListener('keyup', reset);
    target.removeEventListener('paste', onPaste);
  };
}

function graphReferenceHtml(reference) {
  const json = encodeURIComponent(JSON.stringify(reference));
  if (isFileFragmentReference(reference)) {
    const display = `${reference.fileName || reference.path}${reference.format === 'pdf' ? ` · p. ${reference.page}` : ''} · ${reference.text || ''}`;
    return `<a href="${escapeHtml(fileFragmentReferenceHref(reference))}" data-tracegraph-reference="${json}">${escapeHtml(display)}</a>`;
  }
  const isTag = reference.kind === 'tag-reference' || reference.type === 'tag'
    || reference.kind === 'tag-note-reference' || reference.type === 'tag-note';
  const display = isTag ? (reference.label || reference.tagLabel || reference.tagId || '') : reference.type === 'span' ? (reference.text || reference.label || reference.nodeId || '') : (reference.label || reference.nodeId || '');
  const text = escapeHtml(display);
  return `<a href="${escapeHtml(graphReferenceHref(reference))}" data-tracegraph-reference="${json}">${text}</a>`;
}

export function contentReferenceMarkdown(reference) {
  return isFileFragmentReference(reference) ? fileFragmentReferenceMarkdown(reference) : graphReferenceMarkdown(reference);
}

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
