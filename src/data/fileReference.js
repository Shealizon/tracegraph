const MAX_TEXT = 6000;
const MAX_HREF_QUOTE = 900;
const MAX_CONTEXT = 240;

export function fileFragmentReference({
  path,
  name = '',
  format = '',
  page = null,
  rects = [],
  text = '',
  start = null,
  end = null,
  before = '',
  after = '',
  conversationId = '',
} = {}) {
  const filePath = normalizePath(path);
  const quote = String(text || '').trim().slice(0, MAX_TEXT);
  if (!filePath || !quote) return null;
  const normalizedFormat = ['pdf', 'markdown', 'text'].includes(format)
    ? format
    : /\.pdf$/i.test(filePath) ? 'pdf' : /\.(md|markdown)$/i.test(filePath) ? 'markdown' : 'text';
  return {
    version: 1,
    kind: 'file-fragment-reference',
    type: 'file-fragment',
    path: filePath,
    fileName: name || filePath.split('/').pop(),
    conversationId: String(conversationId || ''),
    format: normalizedFormat,
    text: quote,
    ...(normalizedFormat === 'pdf' ? {
      page: Math.max(1, Math.round(Number(page) || 1)),
      rects: normalizeRects(rects),
    } : {
      ...(Number.isFinite(start) ? { start: Math.max(0, Math.round(start)) } : {}),
      ...(Number.isFinite(end) ? { end: Math.max(0, Math.round(end)) } : {}),
      before: String(before || '').slice(-MAX_CONTEXT),
      after: String(after || '').slice(0, MAX_CONTEXT),
    }),
  };
}

export function fileFragmentReferenceHref(reference) {
  if (!isFileFragmentReference(reference)) return '';
  const query = new URLSearchParams();
  query.set('file-fragment', normalizePath(reference.path));
  query.set('format', reference.format || 'text');
  if (reference.conversationId) query.set('conversation', reference.conversationId);
  query.set('quote', String(reference.text || '').slice(0, MAX_HREF_QUOTE));
  if (reference.format === 'pdf') {
    query.set('page', String(Math.max(1, Math.round(Number(reference.page) || 1))));
    const rects = normalizeRects(reference.rects);
    if (rects.length) query.set('rects', rects.map((rect) => [rect.x, rect.y, rect.width, rect.height].join(',')).join(';'));
  } else {
    if (Number.isFinite(reference.start)) query.set('start', String(reference.start));
    if (Number.isFinite(reference.end)) query.set('end', String(reference.end));
    if (reference.before) query.set('before', String(reference.before).slice(-MAX_CONTEXT));
    if (reference.after) query.set('after', String(reference.after).slice(0, MAX_CONTEXT));
  }
  return `#${query.toString()}`;
}

export function parseFileFragmentReferenceHref(href) {
  const value = String(href || '');
  if (!value.startsWith('#')) return null;
  const query = new URLSearchParams(value.slice(1));
  const path = normalizePath(query.get('file-fragment'));
  const text = String(query.get('quote') || '').trim();
  if (!path || !text) return null;
  const number = (key) => {
    const raw = query.get(key);
    if (raw === null || raw === '') return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const format = ['pdf', 'markdown', 'text'].includes(query.get('format')) ? query.get('format') : 'text';
  const rects = format === 'pdf'
    ? String(query.get('rects') || '').split(';').map((entry) => {
      const [x, y, width, height] = entry.split(',').map(Number);
      return { x, y, width, height };
    }).filter((rect) => Object.values(rect).every(Number.isFinite))
    : [];
  return fileFragmentReference({
    path,
    format,
    page: number('page'),
    rects,
    text,
    start: number('start'),
    end: number('end'),
    before: query.get('before') || '',
    after: query.get('after') || '',
    conversationId: query.get('conversation') || '',
  });
}

export function fileFragmentReferenceMarkdown(reference) {
  if (!isFileFragmentReference(reference)) return '';
  const quote = String(reference.text || '').replace(/\s+/g, ' ').trim();
  const snippet = quote.length > 72 ? `${quote.slice(0, 69)}…` : quote;
  const location = reference.format === 'pdf' ? `${reference.fileName || reference.path} · p. ${reference.page}` : (reference.fileName || reference.path);
  const display = `${location} · ${snippet}`.replace(/([\\[\]])/g, '\\$1');
  return `[${display}](${fileFragmentReferenceHref(reference)})`;
}

export function isFileFragmentReference(reference) {
  return !!reference && (reference.kind === 'file-fragment-reference' || reference.type === 'file-fragment')
    && !!normalizePath(reference.path) && !!String(reference.text || '').trim();
}

function normalizePath(value) {
  const path = String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!path || path.split('/').some((part) => !part || part === '.' || part === '..')) return '';
  return path;
}

function normalizeRects(rects) {
  return (rects || []).slice(0, 24).map((rect) => ({
    x: unit(rect.x),
    y: unit(rect.y),
    width: unit(rect.width),
    height: unit(rect.height),
  })).filter((rect) => rect.width > 0 && rect.height > 0);
}

function unit(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, Math.round(number * 10000) / 10000)) : 0;
}
