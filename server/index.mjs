import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { extractGenericTexGraph } from '../src/import/texGeneric.js';
import { UserStore, httpError } from './userStore.mjs';
import { TaskRunner } from './taskRunner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '0.0.0.0';
const store = new UserStore(process.env.PAPER_GRAPH_DATA || path.join(root, 'server-data'));
await store.init();
const tasks = new TaskRunner(store);
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: process.env.JSON_LIMIT || '32mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
});

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'paper-graph', time: new Date().toISOString(), codex: process.env.CODEX_ENABLED !== '0' }));
app.post('/api/auth/register', asyncRoute(async (req, res) => {
  if (process.env.ALLOW_REGISTRATION === '0') throw httpError(403, '服务器未开放自主注册');
  const user = await store.register(req.body || {});
  const login = await store.login(req.body || {});
  setSessionCookie(res, login.token);
  res.status(201).json({ user: login.user || user });
}));
app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const result = await store.login(req.body || {});
  setSessionCookie(res, result.token);
  res.json({ user: result.user });
}));
app.post('/api/auth/logout', asyncRoute(async (req, res) => {
  store.logout(readCookie(req, 'pg_session'));
  res.setHeader('Set-Cookie', 'pg_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.status(204).end();
}));
app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.auth.user }));

app.post('/api/sync', requireAuth, asyncRoute(async (req, res) => {
  const localProjects = Array.isArray(req.body?.projects) ? req.body.projects : [];
  const localDeleted = Array.isArray(req.body?.deleted) ? req.body.deleted : [];
  const vault = await store.updateVault(req.auth.session, (value) => {
    value.projects ||= {};
    value.deletedProjects ||= {};
    for (const deletion of localDeleted) mergeDeletion(value, deletion);
    for (const project of localProjects) mergeProject(value, project);
  });
  res.json({
    projects: Object.values(vault.projects || {}).map((project) => ({ ...project, sync: { state: 'synced', location: 'cloud', syncedAt: new Date().toISOString() } })),
    deleted: Object.entries(vault.deletedProjects || {}).map(([id, deletedAt]) => ({ id, deletedAt })),
    syncedAt: new Date().toISOString(),
  });
}));

app.get('/api/data/export', requireAuth, asyncRoute(async (req, res) => {
  const vault = await store.readVault(req.auth.session);
  const includeSecrets = req.query.secrets === '1';
  const providers = Object.values(vault.providers || {}).map((provider) => includeSecrets ? provider : ({ ...provider, apiKey: provider.apiKey ? '••••••••' : '' }));
  res.setHeader('Content-Disposition', `attachment; filename="entail-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({
    format: 'paper-graph-account@1', exportedAt: new Date().toISOString(),
    projects: Object.values(vault.projects || {}), providers,
    state: vault.state || {}, files: Object.values(vault.files || {}),
  });
}));
app.post('/api/data/import', requireAuth, asyncRoute(async (req, res) => {
  const payload = req.body || {};
  const projects = payload.format === 'paper-graph-account@1' ? payload.projects : [payload];
  const vault = await store.updateVault(req.auth.session, (value) => {
    for (const project of projects.filter(Boolean)) mergeProject(value, project);
    if (payload.format === 'paper-graph-account@1') {
      value.state = { ...(value.state || {}), ...(payload.state && typeof payload.state === 'object' ? payload.state : {}) };
      value.files ||= {};
      for (const file of Array.isArray(payload.files) ? payload.files : []) {
        try {
          const scope = workspacePart(file.scope, 'scope');
          const filePath = workspacePath(file.path);
          if (typeof file.data === 'string' && Buffer.byteLength(file.data, 'base64') <= 20 * 1024 * 1024) value.files[workspaceFileKey(scope, filePath)] = { ...file, scope, path: filePath };
        } catch { /* skip invalid imported file */ }
      }
      value.providers ||= {};
      for (const provider of Array.isArray(payload.providers) ? payload.providers : []) {
        if (safeRecordId(provider?.id) && provider.apiKey && provider.apiKey !== '••••••••') value.providers[provider.id] = { ...provider, runtime: 'server' };
      }
    }
  });
  res.json({ imported: projects.length, projects: Object.values(vault.projects || {}) });
}));

app.get('/api/state/:key', requireAuth, asyncRoute(async (req, res) => {
  const key = stateKey(req.params.key);
  const vault = await store.readVault(req.auth.session);
  res.json({ value: Object.hasOwn(vault.state || {}, key) ? vault.state[key] : null });
}));
app.put('/api/state/:key', requireAuth, asyncRoute(async (req, res) => {
  const key = stateKey(req.params.key);
  const value = req.body?.value;
  await store.updateVault(req.auth.session, (vault) => { vault.state ||= {}; vault.state[key] = value; });
  res.json({ value });
}));

app.get('/api/workspace/files', requireAuth, asyncRoute(async (req, res) => {
  const scope = workspacePart(req.query.scope, 'scope');
  const vault = await store.readVault(req.auth.session);
  const files = Object.values(vault.files || {}).filter((file) => file.scope === scope).map(({ data, ...file }) => file);
  res.json({ files });
}));
app.get('/api/workspace/file', requireAuth, asyncRoute(async (req, res) => {
  const scope = workspacePart(req.query.scope, 'scope');
  const filePath = workspacePath(req.query.path);
  const vault = await store.readVault(req.auth.session);
  const file = vault.files?.[workspaceFileKey(scope, filePath)];
  if (!file) throw httpError(404, '文件不存在');
  res.json({ file });
}));
app.put('/api/workspace/file', requireAuth, asyncRoute(async (req, res) => {
  const scope = workspacePart(req.body?.scope, 'scope');
  const filePath = workspacePath(req.body?.path);
  const data = String(req.body?.data || '');
  if (Buffer.byteLength(data, 'base64') > 20 * 1024 * 1024) throw httpError(413, '单个文件不能超过 20 MB');
  const file = { scope, path: filePath, name: String(req.body?.name || filePath.split('/').at(-1)).slice(0, 180), type: String(req.body?.type || 'application/octet-stream').slice(0, 120), size: Buffer.byteLength(data, 'base64'), updatedAt: new Date().toISOString(), data };
  await store.updateVault(req.auth.session, (vault) => { vault.files ||= {}; vault.files[workspaceFileKey(scope, filePath)] = file; });
  const { data: _data, ...metadata } = file;
  res.json({ file: metadata });
}));
app.delete('/api/workspace/file', requireAuth, asyncRoute(async (req, res) => {
  const scope = workspacePart(req.query.scope, 'scope');
  const filePath = workspacePath(req.query.path);
  await store.updateVault(req.auth.session, (vault) => { delete vault.files?.[workspaceFileKey(scope, filePath)]; });
  res.status(204).end();
}));

app.put('/api/providers/:id', requireAuth, asyncRoute(async (req, res) => {
  const providerId = recordId(req.params.id);
  const input = req.body || {};
  const currentVault = await store.readVault(req.auth.session);
  const existing = Object.hasOwn(currentVault.providers || {}, providerId) ? currentVault.providers[providerId] : null;
  const apiKey = String(input.apiKey || existing?.apiKey || '');
  if (!apiKey) throw httpError(400, '云端服务商必须填写 API Key');
  const provider = {
    id: providerId, name: String(input.name || '').slice(0, 80), protocol: input.protocol,
    baseUrl: String(input.baseUrl || '').replace(/\/+$/, ''), apiKey, model: String(input.model || existing?.model || ''),
    runtime: 'server', updatedAt: new Date().toISOString(),
  };
  await store.updateVault(req.auth.session, (vault) => { vault.providers[provider.id] = provider; });
  res.json({ provider: { ...provider, apiKey: '••••••••' } });
}));
app.delete('/api/providers/:id', requireAuth, asyncRoute(async (req, res) => {
  const providerId = recordId(req.params.id);
  await store.updateVault(req.auth.session, (vault) => { delete vault.providers[providerId]; });
  res.status(204).end();
}));
app.post('/api/providers/:id/models', requireAuth, asyncRoute(async (req, res) => {
  const vault = await store.readVault(req.auth.session);
  const providerId = recordId(req.params.id);
  const provider = Object.hasOwn(vault.providers || {}, providerId) ? vault.providers[providerId] : null;
  if (!provider) throw httpError(404, '云端服务商不存在');
  let url = `${provider.baseUrl}/models`;
  if (provider.protocol === 'gemini') url += '?pageSize=1000';
  const headers = provider.protocol === 'anthropic-messages' ? { 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' } : provider.protocol === 'gemini' ? { 'x-goog-api-key': provider.apiKey } : { authorization: `Bearer ${provider.apiKey}` };
  const response = await fetch(url, { headers });
  const text = await response.text();
  if (!response.ok) throw httpError(response.status, text.slice(0, 500));
  const data = JSON.parse(text);
  const models = provider.protocol === 'gemini' ? (data.models || []).map((item) => String(item.name || '').replace(/^models\//, '')) : (data.data || []).map((item) => item.id);
  res.json({ models: [...new Set(models.filter(Boolean))].sort() });
}));

app.post('/api/ai/tasks', requireAuth, asyncRoute(async (req, res) => res.status(202).json({ task: await tasks.create(req.auth.session, req.body || {}) })));
app.get('/api/ai/tasks', requireAuth, asyncRoute(async (req, res) => res.json({ tasks: await tasks.list(req.auth.session, req.query) })));
app.get('/api/ai/tasks/:id', requireAuth, asyncRoute(async (req, res) => res.json({ task: await tasks.get(req.auth.session, req.params.id) })));
app.delete('/api/ai/tasks/:id', requireAuth, asyncRoute(async (req, res) => res.json({ task: await tasks.cancel(req.auth.session, req.params.id) })));

app.post('/api/tools/extract-tex', requireAuth, asyncRoute(async (req, res) => {
  const source = String(req.body?.source || 'upload.tex');
  const tex = String(req.body?.text || '');
  if (!tex.trim()) throw httpError(400, 'TeX 内容为空');
  res.json({ graph: extractGenericTexGraph(tex, '', { source, title: String(req.body?.title || source.replace(/\.(tex|txt)$/i, '')) }) });
}));

app.get('/api/admin/users', requireAuth, asyncRoute(async (req, res) => res.json({ users: await store.listUsers(req.auth.user) })));
app.patch('/api/admin/users/:id', requireAuth, asyncRoute(async (req, res) => res.json({ user: await store.updateUser(req.auth.user, req.params.id, req.body || {}) })));

app.use(express.static(path.join(root, 'dist'), { index: false, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.get('/{*path}', (_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')));

app.use((error, _req, res, _next) => {
  const status = Number(error.status) || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: error.message || '服务器错误' });
});

app.listen(port, host, () => console.log(`Entail server listening on http://${host}:${port}`));

async function requireAuth(req, res, next) {
  try { req.auth = await store.authenticate(readCookie(req, 'pg_session')); next(); }
  catch (error) { res.status(error.status || 401).json({ error: error.message || '请先登录' }); }
}
function asyncRoute(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next); }
function readCookie(req, name) {
  const item = String(req.headers.cookie || '').split(';').map((value) => value.trim()).find((value) => value.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : '';
}
function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `pg_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${secure}`);
}
function time(value) { const result = Date.parse(value || 0); return Number.isFinite(result) ? result : 0; }
function mergeProject(vault, incoming) {
  if (!safeRecordId(incoming?.id)) return;
  const deletedAt = time(vault.deletedProjects?.[incoming.id]);
  if (deletedAt >= time(incoming.updatedAt)) return;
  const current = vault.projects?.[incoming.id];
  if (!current || time(incoming.updatedAt) >= time(current.updatedAt)) vault.projects[incoming.id] = { ...incoming, sync: undefined };
  delete vault.deletedProjects[incoming.id];
}
function mergeDeletion(vault, deletion) {
  if (!safeRecordId(deletion?.id)) return;
  const deletedAt = deletion.deletedAt || new Date().toISOString();
  const current = vault.projects?.[deletion.id];
  if (!current || time(deletedAt) >= time(current.updatedAt)) {
    delete vault.projects[deletion.id];
    if (time(deletedAt) >= time(vault.deletedProjects?.[deletion.id])) vault.deletedProjects[deletion.id] = deletedAt;
  }
}
function safeRecordId(value) {
  const id = String(value || '');
  return !!id && id.length <= 160 && !['__proto__', 'prototype', 'constructor'].includes(id);
}
function recordId(value) {
  if (!safeRecordId(value)) throw httpError(400, '无效标识符');
  return String(value);
}
function stateKey(value) {
  const key = String(value || '');
  if (!/^[a-zA-Z0-9._:-]{1,220}$/.test(key) || !safeRecordId(key)) throw httpError(400, '无效状态键');
  return key;
}
function workspacePart(value, label) {
  const part = String(value || '');
  if (!part || part.length > 220 || /[\0\\]/.test(part) || part === '.' || part === '..') throw httpError(400, `无效${label}`);
  return part;
}
function workspacePath(value) {
  const filePath = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = filePath.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..' || part.includes('\0')) || filePath.length > 500) throw httpError(400, '无效文件路径');
  return parts.join('/');
}
function workspaceFileKey(scope, filePath) { return `${scope}::${filePath}`; }
