import { login, logout, register, sessionSnapshot } from './session.js';
import { syncNow } from './sync.js';
import { toast } from '../ui/feedback.js';
import { serverApi } from './api.js';

export function mountAccountControls(container, { onChanged = () => {} } = {}) {
  container.replaceChildren();
  const { user, serverReachable } = sessionSnapshot();
  if (!user) {
    const button = document.createElement('button');
    button.className = 'account-button';
    button.innerHTML = `<span class="account-status ${serverReachable ? '' : 'is-offline'}"></span><span>${serverReachable ? '登录' : '离线模式'}</span>`;
    button.addEventListener('click', () => openAuthDialog({ onSuccess: onChanged }));
    container.append(button);
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'account-menu-wrap';
  const button = document.createElement('button');
  button.className = 'account-button is-signed-in';
  button.innerHTML = `<span class="account-avatar">${escapeHtml((user.name || user.email).slice(0, 1).toUpperCase())}</span><span>${escapeHtml(user.name || user.email)}</span><span class="account-caret">⌄</span>`;
  const menu = document.createElement('div');
  menu.className = 'account-menu';
  menu.hidden = true;
  menu.innerHTML = `<div class="account-identity"><strong>${escapeHtml(user.name || '')}</strong><small>${escapeHtml(user.username || user.email)}</small></div><button data-sync>立即同步</button><button data-import>导入数据</button><button data-export>导出云端数据</button><button data-password>修改密码</button>${user.role === 'admin' ? '<button data-admin>管理员面板</button>' : ''}<button data-logout>退出登录</button>`;
  button.addEventListener('click', () => { menu.hidden = !menu.hidden; });
  menu.querySelector('[data-sync]').addEventListener('click', async () => {
    try { await syncNow(); toast('云端与本地已同步'); onChanged(); } catch (error) { toast(error.message, { type: 'error' }); }
  });
  menu.querySelector('[data-export]').addEventListener('click', () => { location.href = '/api/data/export'; });
  menu.querySelector('[data-import]').addEventListener('click', async () => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0]; if (!file) return;
      try { await serverApi.importData(JSON.parse(await file.text())); await syncNow(); toast('数据已导入并同步'); onChanged(); }
      catch (error) { toast(`导入失败：${error.message}`, { type: 'error' }); }
    });
    input.click();
  });
  menu.querySelector('[data-admin]')?.addEventListener('click', () => { location.href = `${location.pathname}?screen=admin`; });
  menu.querySelector('[data-password]').addEventListener('click', () => openChangePasswordDialog());
  menu.querySelector('[data-logout]').addEventListener('click', async () => { await logout(); onChanged(); });
  wrap.append(button, menu);
  container.append(wrap);
}

export function openChangePasswordDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'auth-backdrop';
  overlay.innerHTML = `<form class="auth-dialog"><header><div><span class="auth-eyebrow">ACCOUNT SECURITY</span><h2>修改密码</h2></div><button type="button" data-close aria-label="关闭">×</button></header><p class="auth-copy">修改后将使用新密码保护你的云端工作区，当前登录不会中断。</p><label>当前密码<input name="currentPassword" type="password" autocomplete="current-password" required></label><label>新密码<input name="newPassword" type="password" minlength="8" maxlength="200" autocomplete="new-password" required></label><label>确认新密码<input name="confirmPassword" type="password" minlength="8" maxlength="200" autocomplete="new-password" required></label><p class="auth-error" data-error></p><button class="auth-submit" type="submit">保存新密码</button></form>`;
  document.body.append(overlay);
  const form = overlay.querySelector('form');
  const close = () => overlay.remove();
  overlay.querySelector('[data-close]').addEventListener('click', close);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorEl = overlay.querySelector('[data-error]');
    const submit = overlay.querySelector('.auth-submit');
    const currentPassword = form.elements.namedItem('currentPassword').value;
    const newPassword = form.elements.namedItem('newPassword').value;
    const confirmPassword = form.elements.namedItem('confirmPassword').value;
    errorEl.textContent = '';
    if (newPassword !== confirmPassword) { errorEl.textContent = '两次输入的新密码不一致'; return; }
    submit.disabled = true;
    try {
      await serverApi.changePassword({ currentPassword, newPassword });
      close();
      toast('密码已修改', { type: 'success' });
    } catch (error) { errorEl.textContent = error.message; }
    finally { submit.disabled = false; }
  });
}

export function openAuthDialog({ onSuccess = () => {} } = {}) {
  if (!sessionSnapshot().serverReachable) { toast('服务端不可用，当前仍可继续使用本地功能', { type: 'error' }); return; }
  const overlay = document.createElement('div');
  overlay.className = 'auth-backdrop';
  overlay.innerHTML = `<form class="auth-dialog"><header><div><span class="auth-eyebrow">TRACEGRAPH CLOUD</span><h2>同步你的研究工作区</h2></div><button type="button" data-close aria-label="关闭">×</button></header><p class="auth-copy">本地数据始终保留。登录后，项目和云端任务会使用最新修改自动合并。</p><div class="auth-tabs"><button type="button" class="active" data-mode="login">登录</button><button type="button" data-mode="register">创建账号</button></div><label data-name hidden>显示名称<input name="name" autocomplete="name"></label><label><span data-account-label>账号</span><input name="account" type="text" autocomplete="username" required></label><label>密码<input name="password" type="password" minlength="8" autocomplete="current-password" required></label><p class="auth-error" data-error></p><button class="auth-submit" type="submit">登录并同步</button></form>`;
  document.body.append(overlay);
  const form = overlay.querySelector('form');
  let mode = 'login';
  const setMode = (next) => {
    mode = next;
    overlay.querySelectorAll('[data-mode]').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
    overlay.querySelector('[data-name]').hidden = mode !== 'register';
    const account = form.elements.namedItem('account');
    overlay.querySelector('[data-account-label]').textContent = mode === 'register' ? '邮箱' : '账号';
    account.type = mode === 'register' ? 'email' : 'text';
    account.autocomplete = mode === 'register' ? 'email' : 'username';
    form.elements.namedItem('password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    overlay.querySelector('.auth-submit').textContent = mode === 'register' ? '创建账号并同步' : '登录并同步';
  };
  overlay.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
  const close = () => overlay.remove();
  overlay.querySelector('[data-close]').addEventListener('click', close);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = overlay.querySelector('.auth-submit');
    const errorEl = overlay.querySelector('[data-error]');
    submit.disabled = true; errorEl.textContent = '';
    try {
      const input = mode === 'register'
        ? { email: form.elements.namedItem('account').value, password: form.elements.namedItem('password').value, name: form.elements.namedItem('name').value }
        : { account: form.elements.namedItem('account').value, password: form.elements.namedItem('password').value };
      if (mode === 'register') await register(input); else await login(input);
      await syncNow();
      close(); onSuccess();
    } catch (error) { errorEl.textContent = error.message; }
    finally { submit.disabled = false; }
  });
}

function escapeHtml(value) { return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
