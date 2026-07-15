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
  root.innerHTML = `<main class="admin-page"><header class="admin-topbar"><div><button class="admin-back" data-back>← 项目</button><h1>管理员面板</h1><p>管理账号访问状态与权限。用户工作区内容保持加密，不在此展示。</p></div><div data-account></div></header><section class="admin-summary" data-summary></section><section class="admin-table-wrap"><table class="admin-table"><thead><tr><th>用户</th><th>角色</th><th>状态</th><th>最近登录</th><th></th></tr></thead><tbody data-users></tbody></table></section></main>`;
  root.querySelector('[data-back]').addEventListener('click', () => { location.href = location.pathname; });
  mountAccountControls(root.querySelector('[data-account]'), { onChanged: () => location.reload() });
  const users = (await serverApi.users()).users;
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
}

function formatDate(value) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }); }
function escapeHtml(value) { return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
