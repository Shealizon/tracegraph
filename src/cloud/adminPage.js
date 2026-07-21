import { serverApi } from './api.js';
import { mountAccountControls } from './accountUi.js';
import { sessionSnapshot } from './session.js';
import { toast } from '../ui/feedback.js';
import { ICON } from '../ui/icons.js';

export async function renderAdminPage() {
  applyAdminTheme();
  document.getElementById('app').style.display = 'none';
  const user = sessionSnapshot().user;
  if (!user || user.role !== 'admin') { location.href = location.pathname; return; }
  let root = document.getElementById('leading-root');
  if (!root) { root = document.createElement('div'); root.id = 'leading-root'; document.body.append(root); }
  root.innerHTML = `<main class="admin-page"><header class="admin-topbar"><div><button class="admin-back" data-back>← 项目</button><h1>管理员面板</h1><p>管理账号、服务器 AI、Skills 与工具扩展。用户工作区内容保持加密，不在此展示。</p></div><div data-account></div></header><section class="admin-summary" data-summary></section><section class="admin-codex" id="codex"><div class="admin-section-heading"><div><span class="admin-eyebrow">SERVER AI</span><h2>Codex 登录</h2><p>Codex 只在服务器运行。通过设备码授权，不会向浏览器发送服务器令牌。</p></div><button class="btn btn--primary admin-primary" data-codex-login disabled>检查中…</button></div><div class="codex-status-card" data-codex-status><span class="codex-status-dot"></span><div><strong>正在检查服务器 Codex</strong><small>请稍候</small></div></div><div class="codex-device-login" data-codex-device hidden></div></section><section class="admin-extensions" id="extensions"><div class="admin-section-heading"><div><span class="admin-eyebrow">EXTENSIONS</span><h2>Skills 与工具</h2><p>扩展统一安装在服务器，并自动提供给所有已登录用户。只有管理员可以导入和管理。</p></div><button class="btn btn--primary admin-primary" data-extension-import>${ICON.upload}<span>导入扩展包</span></button><input type="file" accept=".json,application/json" data-extension-file hidden></div><div class="admin-extension-list" data-extension-list><div class="codex-status-card"><div><strong>正在读取扩展</strong><small>请稍候</small></div></div></div></section><div class="admin-section-heading admin-users-heading"><div><span class="admin-eyebrow">ACCESS</span><h2>用户</h2><p>创建账号后，初始密码只显示一次。</p></div><button class="btn btn--primary admin-primary" data-user-create>添加用户</button></div><section class="admin-table-wrap"><table class="admin-table"><thead><tr><th>用户</th><th>角色</th><th>状态</th><th>最近登录</th><th></th></tr></thead><tbody data-users></tbody></table></section></main>`;
  root.querySelector('[data-back]').addEventListener('click', () => { location.href = location.pathname; });
  root.querySelector('[data-user-create]').addEventListener('click', () => openCreateUserDialog({ onCreated: () => renderAdminPage() }));
  mountAccountControls(root.querySelector('[data-account]'), { onChanged: () => location.reload() });
  const [usersResult] = await Promise.all([
    serverApi.users(),
    renderCodexAdmin(root).catch((error) => renderCodexError(root, error)),
    renderExtensionsAdmin(root).catch((error) => renderExtensionsError(root, error)),
  ]);
  const users = usersResult.users;
  root.querySelector('[data-summary]').innerHTML = `<article><strong>${users.length}</strong><span>总用户</span></article><article><strong>${users.filter((item) => item.status === 'active').length}</strong><span>活跃账号</span></article><article><strong>${users.filter((item) => item.role === 'admin').length}</strong><span>管理员</span></article>`;
  const tbody = root.querySelector('[data-users]');
  for (const item of users) {
    const row = document.createElement('tr');
    row.innerHTML = `<td><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.username ? `账号：${item.username}` : item.email)}</small></td><td><select data-role><option value="user"${item.role === 'user' ? ' selected' : ''}>用户</option><option value="admin"${item.role === 'admin' ? ' selected' : ''}>管理员</option></select></td><td><span class="admin-status is-${item.status}">${item.status === 'active' ? '正常' : '已停用'}</span></td><td>${formatDate(item.lastLoginAt)}</td><td><button class="admin-action" data-toggle>${item.status === 'active' ? '停用' : '启用'}</button></td>`;
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

function openCreateUserDialog({ onCreated = () => {} } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'auth-backdrop';
  overlay.innerHTML = `<form class="auth-dialog"><header><div><span class="auth-eyebrow">NEW ACCOUNT</span><h2>添加用户</h2></div><button type="button" data-close aria-label="关闭">×</button></header><p class="auth-copy">输入用户名后，系统会创建同名登录账号并生成随机初始密码。</p><label>用户名<input name="username" type="text" minlength="1" maxlength="32" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="例如 alice" required></label><small class="auth-field-help">可使用小写字母、数字、点、下划线和连字符</small><p class="auth-error" data-error></p><button class="auth-submit" type="submit">创建用户</button></form>`;
  document.body.append(overlay);
  const form = overlay.querySelector('form');
  let created = false;
  const close = () => { overlay.remove(); if (created) onCreated(); };
  overlay.querySelector('[data-close]').addEventListener('click', close);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = overlay.querySelector('.auth-submit');
    const errorEl = overlay.querySelector('[data-error]');
    submit.disabled = true;
    errorEl.textContent = '';
    try {
      const result = await serverApi.createUser(form.elements.namedItem('username').value);
      created = true;
      showCreatedCredentials(overlay, result, close);
    } catch (error) {
      errorEl.textContent = error.message;
      submit.disabled = false;
    }
  });
  form.elements.namedItem('username').focus();
}

function showCreatedCredentials(overlay, { user, initialPassword }, close) {
  const credentials = `登录账号：${user.username}\n初始密码：${initialPassword}`;
  overlay.innerHTML = `<section class="auth-dialog admin-credentials"><header><div><span class="auth-eyebrow">ACCOUNT CREATED</span><h2>用户已创建</h2></div><button type="button" data-close aria-label="关闭">×</button></header><p class="auth-copy">请立即将以下信息安全地交给用户。关闭后无法再次查看初始密码。</p><label>登录账号<input data-created-username readonly value="${escapeAttr(user.username)}"></label><label>初始密码<input data-created-password readonly value="${escapeAttr(initialPassword)}"></label><p class="admin-credentials-warning">用户登录后可从账号菜单修改密码。</p><div class="admin-credentials-actions"><button type="button" class="btn" data-copy>复制账号和密码</button><button type="button" class="btn btn--primary" data-done>完成</button></div></section>`;
  overlay.querySelector('[data-close]').addEventListener('click', close);
  overlay.querySelector('[data-done]').addEventListener('click', close);
  overlay.querySelector('[data-copy]').addEventListener('click', async (event) => {
    try {
      await copyText(credentials);
      event.currentTarget.textContent = '已复制';
    } catch { toast('复制失败，请手动复制', { type: 'error' }); }
  });
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return; }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand?.('copy');
  textarea.remove();
  if (!copied) throw new Error('copy unavailable');
}

async function renderExtensionsAdmin(root) {
  const catalog = await serverApi.adminExtensions();
  const list = root.querySelector('[data-extension-list]');
  list.innerHTML = '';
  for (const failure of catalog.failures || []) {
    const notice = document.createElement('div');
    notice.className = 'admin-extension-notice is-error';
    notice.innerHTML = `<span class="admin-extension-notice-icon">!</span><div><strong>${escapeHtml(failure.name || failure.id)} 安装失败</strong><small>${escapeHtml(failure.error || '请检查服务器日志')}</small></div></div>`;
    list.append(notice);
  }
  for (const item of catalog.packages || []) {
    const card = document.createElement('article');
    card.className = `admin-extension-card${item.ready ? '' : ' is-unavailable'}`;
    card.innerHTML = extensionCardHtml(item);
    card.querySelector('[data-delete]')?.addEventListener('click', async () => {
      if (!confirm(`删除扩展「${item.name}」？`)) return;
      try {
        await serverApi.deleteExtension(item.id);
        toast('扩展已删除', { type: 'success' });
        await renderExtensionsAdmin(root);
      } catch (error) { toast(error.message, { type: 'error' }); }
    });
    for (const open of card.querySelectorAll('[data-secret-open]')) {
      open.addEventListener('click', () => {
        const row = open.closest('[data-environment-row]');
        const form = row?.querySelector('[data-secret-form]');
        if (!form) return;
        form.hidden = false;
        form.querySelector('input')?.focus();
      });
    }
    for (const cancel of card.querySelectorAll('[data-secret-cancel]')) {
      cancel.addEventListener('click', () => { cancel.closest('[data-secret-form]').hidden = true; });
    }
    for (const form of card.querySelectorAll('[data-secret-form]')) {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const key = form.dataset.key;
        const input = form.querySelector('input');
        const submit = form.querySelector('[type="submit"]');
        if (!input.value.trim()) { toast(`${key} 不能为空`, { type: 'error' }); return; }
        submit.disabled = true;
        submit.textContent = '保存中…';
        try {
          await serverApi.saveExtensionEnvironment(key, input.value);
          input.value = '';
          toast(`${key} 已安全保存`, { type: 'success' });
          await renderExtensionsAdmin(root);
        } catch (error) {
          toast(error.message, { type: 'error' });
          submit.disabled = false;
          submit.textContent = '保存';
        }
      });
    }
    for (const clear of card.querySelectorAll('[data-secret-clear]')) {
      clear.addEventListener('click', async () => {
        const key = clear.dataset.secretClear;
        if (!confirm(`移除服务器密钥 ${key}？对应工具将立即不可用。`)) return;
        try {
          await serverApi.deleteExtensionEnvironment(key);
          toast(`${key} 已移除`);
          await renderExtensionsAdmin(root);
        } catch (error) { toast(error.message, { type: 'error' }); }
      });
    }
    list.append(card);
  }
  if (!catalog.packages?.length && !catalog.failures?.length) list.innerHTML = '<div class="codex-status-card"><div><strong>尚未安装扩展</strong><small>导入一个 tracegraph-extension@1 JSON 包</small></div></div>';
  const input = root.querySelector('[data-extension-file]');
  const button = root.querySelector('[data-extension-import]');
  button.onclick = () => input.click();
  input.onchange = async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    button.disabled = true;
    button.innerHTML = '<span class="admin-button-spinner" aria-hidden="true"></span><span>安装依赖中…</span>';
    try {
      const bundle = JSON.parse(await file.text());
      const result = await serverApi.importExtension(bundle);
      toast(`已安装 ${result.extension.name} v${result.extension.version}`, { type: 'success' });
      await renderExtensionsAdmin(root);
    } catch (error) {
      toast(error instanceof SyntaxError ? '扩展包不是有效 JSON' : error.message, { type: 'error' });
    } finally {
      button.disabled = false;
      button.innerHTML = `${ICON.upload}<span>导入扩展包</span>`;
    }
  };
}

function extensionCardHtml(item) {
  const missingEnv = Array.isArray(item.missingEnv) ? item.missingEnv : [];
  const status = item.ready
    ? '<span class="admin-extension-state is-ready"><i></i>可用</span>'
    : '<span class="admin-extension-state is-warning"><i></i>需配置</span>';
  const skills = Array.isArray(item.skills) ? item.skills : [];
  const tools = Array.isArray(item.tools) ? item.tools : [];
  const dependencies = Array.isArray(item.dependencies?.python) ? item.dependencies.python : [];
  const environment = Array.isArray(item.environment)
    ? item.environment
    : missingEnv.map((key) => ({ key, configured: false, source: '' }));
  const typeLabel = item.builtIn ? '内置扩展' : '自定义扩展';
  const environmentPanel = environment.length ? `<div class="admin-extension-environment${item.ready ? '' : ' is-warning'}"><div class="admin-extension-environment-title"><span>服务器密钥</span><small>值经过加密保存，不会回传浏览器</small></div>${environment.map(environmentRowHtml).join('')}</div>` : '';
  const deleteButton = item.builtIn ? '' : `<button class="btn btn--sm btn--danger admin-extension-delete" data-delete>${ICON.trash}<span>删除</span></button>`;
  const dependencyContent = dependencies.length
    ? `<div class="admin-extension-code-list">${dependencies.map((dependency) => `<code>${escapeHtml(dependency)}</code>`).join('')}</div>`
    : '<p class="admin-extension-empty">无额外 Python 依赖</p>';
  const skillContent = skills.length
    ? `<div class="admin-extension-capability-list">${skills.map((skill) => `<span>${ICON.fileText}<b>${escapeHtml(skill.name)}</b></span>`).join('')}</div>`
    : '<p class="admin-extension-empty">未包含 Skill</p>';
  const toolContent = tools.length
    ? `<div class="admin-extension-code-list is-tools">${tools.map((tool) => `<code>${escapeHtml(tool.name)}</code>`).join('')}</div>`
    : '<p class="admin-extension-empty">未包含工具</p>';
  return `<header class="admin-extension-card-head"><div class="admin-extension-mark">${ICON.settings}</div><div class="admin-extension-identity"><div class="admin-extension-name"><strong>${escapeHtml(item.name)}</strong>${status}</div><span>${escapeHtml(item.id)} <i>·</i> v${escapeHtml(item.version)} <i>·</i> ${typeLabel}</span></div>${deleteButton}</header><p class="admin-extension-description">${escapeHtml(item.description)}</p><div class="admin-extension-metrics"><span><b>${skills.length}</b> Skill${skills.length === 1 ? '' : 's'}</span><span><b>${tools.length}</b> 工具</span></div>${environmentPanel}<details class="admin-extension-details"><summary><span>查看依赖与能力</span>${ICON.chevronDown}</summary><div class="admin-extension-detail-body"><section><h4>Python 依赖</h4>${dependencyContent}</section><section><h4>Skills</h4>${skillContent}</section><section><h4>工具</h4>${toolContent}</section></div></details>`;
}

function environmentRowHtml(environment) {
  const key = escapeHtml(environment.key);
  const sourceText = environment.source === 'server' ? '由服务器环境提供' : environment.configured ? '已安全保存' : '尚未配置';
  const stateClass = environment.configured ? 'is-configured' : 'is-missing';
  const actions = environment.source === 'server'
    ? ''
    : `<button type="button" class="btn btn--sm" data-secret-open>${environment.configured ? '更新' : '配置'}</button>${environment.source === 'admin' ? `<button type="button" class="btn btn--sm btn--danger" data-secret-clear="${escapeAttr(environment.key)}">移除</button>` : ''}`;
  return `<div class="admin-extension-environment-row ${stateClass}" data-environment-row><div class="admin-extension-environment-key"><i></i><code>${key}</code><span>${sourceText}</span></div><div class="admin-extension-environment-actions">${actions}</div><form class="admin-extension-secret-form" data-secret-form data-key="${escapeAttr(environment.key)}" hidden><label><span>${environment.configured ? `输入新的 ${key}` : `填写 ${key}`}</span><input type="password" autocomplete="new-password" spellcheck="false" placeholder="仅在服务端加密保存"></label><div><button type="button" class="btn btn--sm" data-secret-cancel>取消</button><button type="submit" class="btn btn--sm btn--primary">保存</button></div></form></div>`;
}

function renderExtensionsError(root, error) {
  const list = root.querySelector('[data-extension-list]');
  if (list) list.innerHTML = `<div class="codex-status-card is-offline"><div><strong>无法读取扩展</strong><small>${escapeHtml(error?.message || '服务器请求失败')}</small></div></div>`;
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
  panel.innerHTML = `<div class="codex-device-copy"><span>${waiting ? '等待授权' : login.status === 'completed' ? '授权完成' : '授权未完成'}</span><strong>${escapeHtml(login.userCode || '正在获取设备码…')}</strong><small>在 OpenAI 登录页面输入此一次性代码。完成后本页会自动更新。</small></div>${login.verificationUrl ? `<a class="btn btn--primary admin-primary" href="${escapeAttr(login.verificationUrl)}" target="_blank" rel="noopener noreferrer">打开登录页面 ↗</a>` : ''}`;
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

function applyAdminTheme() {
  const mode = localStorage.getItem('hg-theme-mode') || localStorage.getItem('hg-theme') || 'system';
  const theme = mode === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : mode;
  document.documentElement.setAttribute('data-theme', theme);
}

function formatDate(value) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }); }
function escapeHtml(value) { return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeAttr(value) { return escapeHtml(value).replace(/"/g, '&quot;'); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
