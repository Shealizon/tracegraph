export async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body != null ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
    body: options.body != null && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  if (response.status === 204) return null;
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : null; } catch { value = text; }
  if (!response.ok) throw Object.assign(new Error(value?.error || String(value || `HTTP ${response.status}`)), { status: response.status });
  return value;
}

export const serverApi = {
  me: () => apiRequest('/api/auth/me'),
  login: (input) => apiRequest('/api/auth/login', { method: 'POST', body: input }),
  register: (input) => apiRequest('/api/auth/register', { method: 'POST', body: input }),
  logout: () => apiRequest('/api/auth/logout', { method: 'POST' }),
  sync: (projects, deleted) => apiRequest('/api/sync', { method: 'POST', body: { projects, deleted } }),
  importData: (payload) => apiRequest('/api/data/import', { method: 'POST', body: payload }),
  getState: (key) => apiRequest(`/api/state/${encodeURIComponent(key)}`),
  saveState: (key, value) => apiRequest(`/api/state/${encodeURIComponent(key)}`, { method: 'PUT', body: { value } }),
  listFiles: (scope) => apiRequest(`/api/workspace/files?${new URLSearchParams({ scope })}`),
  getFile: (scope, path) => apiRequest(`/api/workspace/file?${new URLSearchParams({ scope, path })}`),
  putFile: (file) => apiRequest('/api/workspace/file', { method: 'PUT', body: file }),
  deleteFile: (scope, path) => apiRequest(`/api/workspace/file?${new URLSearchParams({ scope, path })}`, { method: 'DELETE' }),
  users: () => apiRequest('/api/admin/users'),
  updateUser: (id, patch) => apiRequest(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
  saveProvider: (id, provider) => apiRequest(`/api/providers/${encodeURIComponent(id)}`, { method: 'PUT', body: provider }),
  deleteProvider: (id) => apiRequest(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  discoverServerModels: (id) => apiRequest(`/api/providers/${encodeURIComponent(id)}/models`, { method: 'POST', body: {} }),
  createTask: (input) => apiRequest('/api/ai/tasks', { method: 'POST', body: input }),
  getTask: (id) => apiRequest(`/api/ai/tasks/${encodeURIComponent(id)}`),
  listTasks: (query = {}) => apiRequest(`/api/ai/tasks?${new URLSearchParams(query)}`),
  cancelTask: (id) => apiRequest(`/api/ai/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  extractTex: (input) => apiRequest('/api/tools/extract-tex', { method: 'POST', body: input }),
};
