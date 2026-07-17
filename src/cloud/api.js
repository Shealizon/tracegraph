import { debugCheckpoint, debugError } from '../debug/diagnostics.js';

export async function apiRequest(path, options = {}) {
  const startedAt = performance.now();
  const method = options.method || 'GET';
  const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  debugCheckpoint('src/cloud/api.js', 'request-start', { requestId, method, path });
  let response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers: { ...(options.body != null ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
      body: options.body != null && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
    });
  } catch (error) {
    debugError('src/cloud/api.js', 'request-network-error', error, {
      requestId, method, path, durationMs: performance.now() - startedAt,
    });
    throw error;
  }
  if (response.status === 204) {
    debugCheckpoint('src/cloud/api.js', 'request-complete', {
      requestId, method, path, status: response.status, durationMs: performance.now() - startedAt,
    });
    return null;
  }
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : null; } catch { value = text; }
  if (!response.ok) {
    const error = Object.assign(new Error(value?.error || String(value || `HTTP ${response.status}`)), { status: response.status });
    debugError('src/cloud/api.js', 'request-http-error', error, {
      requestId, method, path, status: response.status, durationMs: performance.now() - startedAt,
    });
    throw error;
  }
  debugCheckpoint('src/cloud/api.js', 'request-complete', {
    requestId, method, path, status: response.status, durationMs: performance.now() - startedAt,
  });
  return value;
}

export async function streamTask(taskId, { signal, onTask } = {}) {
  const response = await fetch(`/api/ai/tasks/${encodeURIComponent(taskId)}/events`, {
    credentials: 'same-origin',
    headers: { Accept: 'text/event-stream' },
    signal,
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try { message = JSON.parse(text)?.error || text; } catch { /* plain-text server error */ }
    throw Object.assign(new Error(message || `HTTP ${response.status}`), { status: response.status });
  }
  if (!response.body) throw new Error('任务事件流不可用');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let latest = null;
  const consume = (block) => {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    try {
      const value = JSON.parse(data);
      if (value?.task) {
        latest = value.task;
        onTask?.(latest);
      }
    } catch { /* ignore malformed event and continue the stream */ }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || '';
    blocks.forEach(consume);
  }
  buffer += decoder.decode();
  if (buffer.trim()) consume(buffer);
  if (!latest) throw new Error('任务事件流未返回状态');
  if (!['completed', 'failed', 'cancelled'].includes(latest.status)) throw new Error('任务事件流提前断开');
  return latest;
}

export const serverApi = {
  me: () => apiRequest('/api/auth/me'),
  login: (input) => apiRequest('/api/auth/login', { method: 'POST', body: input }),
  register: (input) => apiRequest('/api/auth/register', { method: 'POST', body: input }),
  logout: () => apiRequest('/api/auth/logout', { method: 'POST' }),
  changePassword: (input) => apiRequest('/api/auth/password', { method: 'POST', body: input }),
  sync: (projects, deleted) => apiRequest('/api/sync', { method: 'POST', body: { projects, deleted } }),
  importData: (payload) => apiRequest('/api/data/import', { method: 'POST', body: payload }),
  getState: (key) => apiRequest(`/api/state/${encodeURIComponent(key)}`),
  saveState: (key, value) => apiRequest(`/api/state/${encodeURIComponent(key)}`, { method: 'PUT', body: { value } }),
  listFiles: (scope) => apiRequest(`/api/workspace/files?${new URLSearchParams({ scope })}`),
  getFile: (scope, path) => apiRequest(`/api/workspace/file?${new URLSearchParams({ scope, path })}`),
  putFile: (file) => apiRequest('/api/workspace/file', { method: 'PUT', body: file }),
  deleteFile: (scope, path) => apiRequest(`/api/workspace/file?${new URLSearchParams({ scope, path })}`, { method: 'DELETE' }),
  extensionCatalog: () => apiRequest('/api/extensions/catalog'),
  getSkill: (id) => apiRequest(`/api/skills/${encodeURIComponent(id)}`),
  executeExtensionTool: (name, args, workspaceScope, projectId, writeApproved = false) => apiRequest('/api/tools/execute', {
    method: 'POST',
    body: { name, args, workspaceScope, projectId, writeApproved },
  }),
  users: () => apiRequest('/api/admin/users'),
  createUser: (username) => apiRequest('/api/admin/users', { method: 'POST', body: { username } }),
  updateUser: (id, patch) => apiRequest(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
  codexStatus: () => apiRequest('/api/codex/status'),
  adminCodexStatus: () => apiRequest('/api/admin/codex/status'),
  startCodexDeviceLogin: () => apiRequest('/api/admin/codex/login/device', { method: 'POST', body: {} }),
  getCodexDeviceLogin: (id) => apiRequest(`/api/admin/codex/login/${encodeURIComponent(id)}`),
  cancelCodexDeviceLogin: (id) => apiRequest(`/api/admin/codex/login/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  adminExtensions: () => apiRequest('/api/admin/extensions'),
  importExtension: (bundle) => apiRequest('/api/admin/extensions/import', { method: 'POST', body: bundle }),
  saveExtensionEnvironment: (key, value) => apiRequest(`/api/admin/extensions/environment/${encodeURIComponent(key)}`, { method: 'PUT', body: { value } }),
  deleteExtensionEnvironment: (key) => apiRequest(`/api/admin/extensions/environment/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  deleteExtension: (id) => apiRequest(`/api/admin/extensions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  saveProvider: (id, provider) => apiRequest(`/api/providers/${encodeURIComponent(id)}`, { method: 'PUT', body: provider }),
  deleteProvider: (id) => apiRequest(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  discoverServerModels: (id) => apiRequest(`/api/providers/${encodeURIComponent(id)}/models`, { method: 'POST', body: {} }),
  discoverCodexModels: (refresh = false) => apiRequest(`/api/codex/models${refresh ? '?refresh=1' : ''}`),
  createTask: (input) => apiRequest('/api/ai/tasks', { method: 'POST', body: input }),
  streamTask,
  getTask: (id) => apiRequest(`/api/ai/tasks/${encodeURIComponent(id)}`),
  listTasks: (query = {}) => apiRequest(`/api/ai/tasks?${new URLSearchParams(query)}`),
  cancelTask: (id) => apiRequest(`/api/ai/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  extractTex: (input) => apiRequest('/api/tools/extract-tex', { method: 'POST', body: input }),
};
