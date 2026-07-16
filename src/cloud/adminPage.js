import { serverApi } from './api.js';
import { mountAccountControls } from './accountUi.js';
import { sessionSnapshot } from './session.js';
import { toast } from '../ui/feedback.js';

export async function renderAdminPage() {
  document.getElementById('app').style.display = 'none';
  const user = sessionSnapshot().user;
  if (!user || user.role !== 'admin') { location.href = location.pathname; return; }
  let root = document.getElementById('leading-root');
  if (!root) { root = document.createElement('div'); root.id = 'leading-root'; document.body.append(root); }
  root.innerHTML = `<main class="admin-page"><header class="admin-topbar"><div><button class="admin-back" data-back>← 项目</button><h1>管理员面板</h1><p>管理账号与服务器 AI 服务。用户工作区内容保持加密，不在此展示。</p></div><div data-account></div></header><section class="admin-summary" data-summary></section><section class="admin-codex" id="codex"><div class="admin-section-heading"><div><span class="admin-eyebrow">SERVER AI</span><h2>Codex 登录</h2><p>Codex 只在服务器运行。通过设备码授权，不会向浏览器发送服务器令牌。</p></div><button class="admin-primary" data-codex-login disabled>检查中…</button></div><div class="codex-status-card" data-codex-status><span class="codex-status-dot"></span><div><strong>正在检查服务器 Codex</strong><small>请稍候</small></div></div><div class="codex-device-login" data-codex-device hidden></div></section><div class="admin-section-heading admin-users-heading"><div><span class="admin-eyebrow">ACCESS</span><h2>用户</h2></div></div><section class="admin-table-wrap"><table class="admin-table"><thead><tr><th>用户</th><th>角色</th><th>状态</th><th>最近登录</th><th></th></tr></thead><tbody data-users></tbody></table></section></main>`;
  root.querySelector('[data-back]').addEventListener('click', () => { location.href = location.pathname; });
  mountAccountControls(root.querySelector('[data-account]'), { onChanged: () => location.reload() });
  const [usersResult] = await Promise.all([
    serverApi.users(),
    renderCodexAdmin(root).catch((error) => renderCodexError(root, error)),
  ]);
  const users = usersResult.users;
  root.querySelector('[data-summary]').innerHTML = `<article><strong>${users.length}</strong><span>总用户</span></article><article><strong>${users.filter((item) => item.status === 'active').length}</strong><span>活跃账号</span></article><article><strong>${users.filter((item) => item.role === 'admin').length}</strong><span>管理员</span></article>`;
  const tbody = root.querySelector('[data-users]');
  for (const item of users) {
    const row = document.createElement('tr');
    row.innerHTML = `<td><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.email)}</small></td><td><select data-role><option value="user"${item.role === 'user' ? ' selected' : ''}>用户</option><option value="admin"${item.role === 'admin' ? ' selected' : ''}>管理员</option></select></td><td><span class="admin-status is-${item.status}">${item.status === 'active' ? '正常' : '已停用'}</span></td><td>${formatDate(item.lastLoginAt)}</td><td><button class="admin-action" data-toggle>${item.status === 'active' ? '停用' : '启用'}</button></td>`;
    row.querySelector('[data-role]').disabled = item.id === user.id;
    row.querySelector('[data-role]').addEventListener('change', async (event) => {
      try { await serverApi.updateUser(item.id, { role: event.target.value }); toast('权限已更新'); } catch (error) { toast(error.message, { type: 'error' }); }
    });
    row.querySelector('[data-toggle]').disabled = item.id === user.id;
    row.querySelector('[data-toggle]').addEventListener('click', async () => {
      try { await serverApi.updateUser(item.id, { status: item.status === 'active' ? 'suspended' : 'active' }); renderAdminPage(); } catch (error) { toast(error.message, { type: 'error' }); }
    });
    tbody.append(row);
  }
  if (location.hash === '#codex') requestAnimationFrame(() => root.querySelector('#codex')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

async function renderCodexAdmin(root) {
  const status = await serverApi.adminCodexStatus();
  const card = root.querySelector('[data-codex-status]');
  const button = root.querySelector('[data-codex-login]');
  card.classList.toggle('is-ready', status.authenticated);
  card.classList.toggle('is-offline', !status.authenticated);
  card.querySelector('strong').textContent = status.authenticated ? '服务器 Codex 已登录' : '服务器 Codex 尚未登录';
  card.querySelector('small').textContent = [status.authMethod, status.version ? `CLI ${status.version}` : ''].filter(Boolean).join(' · ') || status.message;
  button.disabled = !status.enabled;
  button.textContent = status.authenticated ? '重新登录' : '登录 Codex';
  button.onclick = () => beginCodexLogin(root, button);
}

async function beginCodexLogin(root, button) {
  button.disabled = true;
  button.textContent = '正在生成设备码…';
  try {
    const { login } = await serverApi.startCodexDeviceLogin();
    renderDeviceLogin(root, login);
    await pollCodexLogin(root, login.id);
  } catch (error) {
    toast(error.message, { type: 'error' });
  } finally {
    if (root.isConnected) {
      button.disabled = false;
      await renderCodexAdmin(root).catch((error) => renderCodexError(root, error));
    }
  }
}

async function pollCodexLogin(root, id) {
  while (root.isConnected) {
    const { login } = await serverApi.getCodexDeviceLogin(id);
    renderDeviceLogin(root, login);
    if (login.status === 'completed') { toast('服务器 Codex 登录成功', { type: 'success' }); return; }
    if (login.status === 'failed' || login.status === 'cancelled') throw new Error(login.error || 'Codex 登录未完成');
    await delay(1_500);
  }
  await serverApi.cancelCodexDeviceLogin(id).catch(() => {});
}

function renderDeviceLogin(root, login) {
  const panel = root.querySelector('[data-codex-device]');
  panel.hidden = false;
  const waiting = login.status === 'waiting';
  panel.innerHTML = `<div class="codex-device-copy"><span>${waiting ? '等待授权' : login.status === 'completed' ? '授权完成' : '授权未完成'}</span><strong>${escapeHtml(login.userCode || '正在获取设备码…')}</strong><small>在 OpenAI 登录页面输入此一次性代码。完成后本页会自动更新。</small></div>${login.verificationUrl ? `<a class="admin-primary" href="${escapeAttr(login.verificationUrl)}" target="_blank" rel="noopener noreferrer">打开登录页面 ↗</a>` : ''}`;
}

function renderCodexError(root, error) {
  const card = root.querySelector('[data-codex-status]');
  card?.classList.add('is-offline');
  if (card) {
    card.querySelector('strong').textContent = '无法读取 Codex 状态';
    card.querySelector('small').textContent = error?.message || '服务器请求失败';
  }
  const button = root.querySelector('[data-codex-login]');
  if (button) { button.disabled = false; button.textContent = '重试'; button.onclick = () => renderCodexAdmin(root).catch((nextError) => renderCodexError(root, nextError)); }
}

function formatDate(value) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }); }
function escapeHtml(value) { return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeAttr(value) { return escapeHtml(value).replace(/"/g, '&quot;'); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
