export const DEBUG_EXPORT_FORMAT = 'entail-debug-log@1';
const MAX_RECORDS = 5000;
const records = [];
const moduleBreakpoints = new Map();
let sequence = 0;
let installed = false;
let contextProvider = () => ({});

const discoveredModules = ['src/debug/diagnostics.js', ...Object.keys(import.meta.glob('../**/*.js'))];
registerDebugModules(discoveredModules);

export function registerDebugModules(paths = []) {
  const armedAt = new Date().toISOString();
  for (const path of paths) {
    const module = normalizeModuleName(path);
    if (!moduleBreakpoints.has(module)) {
      moduleBreakpoints.set(module, { module, status: 'armed', armedAt, hits: 0, lastEvent: '', lastHitAt: '' });
    }
  }
  return [...moduleBreakpoints.values()];
}

export function debugCheckpoint(module, event, data = null, { level = 'debug' } = {}) {
  const moduleName = normalizeModuleName(module);
  if (!moduleBreakpoints.has(moduleName)) registerDebugModules([moduleName]);
  const breakpoint = moduleBreakpoints.get(moduleName);
  breakpoint.hits += 1;
  breakpoint.lastEvent = String(event || 'checkpoint');
  breakpoint.lastHitAt = new Date().toISOString();
  const record = {
    id: ++sequence,
    timestamp: breakpoint.lastHitAt,
    elapsedMs: Math.round(now() * 1000) / 1000,
    level: normalizeLevel(level),
    module: moduleName,
    event: breakpoint.lastEvent,
    data: normalizeDebugValue(data),
  };
  records.push(record);
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
  return record;
}

export function debugError(module, event, error, data = null) {
  return debugCheckpoint(module, event, {
    ...normalizeObject(data),
    error: normalizeError(error),
  }, { level: 'error' });
}

export function setDebugContextProvider(provider) {
  contextProvider = typeof provider === 'function' ? provider : () => ({});
}

export function installDiagnostics({ getContext } = {}) {
  if (getContext) setDebugContextProvider(getContext);
  if (installed || typeof window === 'undefined') return;
  installed = true;
  captureConsole();
  window.addEventListener('error', (event) => {
    debugError('runtime/window', 'uncaught-error', event.error || event.message, {
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    debugError('runtime/window', 'unhandled-rejection', event.reason);
  });
  window.addEventListener('keydown', (event) => {
    if (!event.ctrlKey || event.altKey || event.shiftKey || event.key !== 'F10') return;
    event.preventDefault();
    exportDebugLog('ctrl-f10');
  });
  window.__entailDebug = {
    checkpoint: debugCheckpoint,
    snapshot: createDebugSnapshot,
    export: exportDebugLog,
    clear: clearDebugRecords,
  };
  debugCheckpoint('runtime/diagnostics', 'installed', {
    armedModuleCount: moduleBreakpoints.size,
    shortcut: 'Ctrl+F10',
  }, { level: 'info' });
}

export function createDebugSnapshot({ reason = 'manual' } = {}) {
  let context = {};
  try { context = normalizeDebugValue(contextProvider() || {}); }
  catch (error) { context = { providerError: normalizeError(error) }; }
  return {
    format: DEBUG_EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    reason,
    context,
    environment: environmentSnapshot(),
    moduleBreakpoints: [...moduleBreakpoints.values()].map((item) => ({ ...item })),
    records: records.map((record) => ({ ...record })),
    performance: performanceSnapshot(),
  };
}

export function exportDebugLog(reason = 'manual') {
  debugCheckpoint('runtime/diagnostics', 'export', { reason }, { level: 'info' });
  const snapshot = createDebugSnapshot({ reason });
  const stamp = snapshot.exportedAt.replace(/[:.]/g, '-');
  downloadDebugSnapshot(snapshot, `entail-debug-${stamp}.json`);
  return snapshot;
}

export function clearDebugRecords() {
  records.length = 0;
  sequence = 0;
}

function captureConsole() {
  for (const level of ['debug', 'info', 'warn', 'error']) {
    const original = console[level]?.bind(console);
    if (!original || original.__entailWrapped) continue;
    const wrapped = (...args) => {
      debugCheckpoint('runtime/console', level, { arguments: args }, { level });
      original(...args);
    };
    wrapped.__entailWrapped = true;
    console[level] = wrapped;
  }
}

function environmentSnapshot() {
  if (typeof window === 'undefined') return {};
  return normalizeDebugValue({
    url: location.href,
    title: document.title,
    visibility: document.visibilityState,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    online: navigator.onLine,
    language: navigator.language,
    userAgent: navigator.userAgent,
    memory: performance?.memory ? {
      usedJSHeapSize: performance.memory.usedJSHeapSize,
      totalJSHeapSize: performance.memory.totalJSHeapSize,
      jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
    } : null,
    dom: {
      nodes: document.querySelectorAll('.node').length,
      modals: document.querySelectorAll('.modal').length,
      aiMessages: document.querySelectorAll('.ai-message').length,
      detailsOpen: Boolean(document.querySelector('.details-page')),
    },
  });
}

function performanceSnapshot() {
  if (typeof performance === 'undefined' || !performance.getEntriesByType) return [];
  return performance.getEntriesByType('resource').slice(-300).map((entry) => ({
    name: entry.name,
    initiatorType: entry.initiatorType,
    startTime: Math.round(entry.startTime * 1000) / 1000,
    duration: Math.round(entry.duration * 1000) / 1000,
    transferSize: entry.transferSize,
    encodedBodySize: entry.encodedBodySize,
    decodedBodySize: entry.decodedBodySize,
  }));
}

function normalizeDebugValue(value, depth = 0, seen = new WeakSet(), key = '') {
  if (isSensitiveKey(key)) return '[REDACTED]';
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (value instanceof Error) return normalizeError(value);
  if (typeof Node !== 'undefined' && value instanceof Node) {
    return { node: value.nodeName, id: value.id || '', className: value.className || '' };
  }
  if (depth >= 6) return '[MaxDepth]';
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => normalizeDebugValue(item, depth + 1, seen));
  const output = {};
  for (const [childKey, childValue] of Object.entries(value).slice(0, 200)) {
    output[childKey] = normalizeDebugValue(childValue, depth + 1, seen, childKey);
  }
  return output;
}

function normalizeObject(value) {
  const normalized = normalizeDebugValue(value);
  return normalized && typeof normalized === 'object' && !Array.isArray(normalized) ? normalized : { detail: normalized };
}

function normalizeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack || '',
      cause: error.cause ? normalizeDebugValue(error.cause) : null,
    };
  }
  return { name: 'Error', message: String(error ?? 'Unknown error'), stack: '' };
}

function normalizeModuleName(value) {
  const normalized = String(value || 'unknown')
    .replace(/\\/g, '/')
    .replace(/^.*\/src\//, 'src/')
    .replace(/^\.\.\/+/, 'src/');
  return normalized.startsWith('./') ? `src/debug/${normalized.slice(2)}` : normalized;
}

function normalizeLevel(value) {
  return ['debug', 'info', 'warn', 'error'].includes(value) ? value : 'debug';
}

function isSensitiveKey(value) {
  return /password|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|cookie/i.test(String(value || ''));
}

function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

function downloadDebugSnapshot(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const anchor = document.createElement('a');
  const url = URL.createObjectURL(blob);
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
