import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';

const STATUS_CACHE_MS = 10_000;
const COMMAND_TIMEOUT_MS = 15_000;
const LOGIN_TTL_MS = 30 * 60_000;
const LOGIN_START_TIMEOUT_MS = 20_000;

export class CodexAuthManager {
  constructor({ spawnImpl = spawn, loginStartTimeoutMs = LOGIN_START_TIMEOUT_MS } = {}) {
    this.spawnImpl = spawnImpl;
    this.loginStartTimeoutMs = loginStartTimeoutMs;
    this.logins = new Map();
    this.cachedStatus = null;
  }

  async status({ force = false } = {}) {
    if (process.env.CODEX_ENABLED === '0') return { enabled: false, authenticated: false, message: '服务器未启用 Codex' };
    if (!force && this.cachedStatus && Date.now() - this.cachedStatus.cachedAt < STATUS_CACHE_MS) return publicStatus(this.cachedStatus);
    const [login, version] = await Promise.all([
      captureCodex(['login', 'status'], this.spawnImpl),
      captureCodex(['--version'], this.spawnImpl),
    ]);
    const loginText = `${login.stdout}\n${login.stderr}`.trim();
    const authenticated = login.code === 0 && /logged in/i.test(loginText);
    const authMethod = authenticated
      ? (/chatgpt/i.test(loginText) ? 'ChatGPT' : /api key/i.test(loginText) ? 'API Key' : '已登录')
      : '';
    this.cachedStatus = {
      enabled: true,
      authenticated,
      authMethod,
      version: firstLine(version.stdout || version.stderr).replace(/^codex-cli\s+/i, ''),
      message: authenticated ? '服务器 Codex 已登录' : '服务器 Codex 尚未登录',
      cachedAt: Date.now(),
    };
    return publicStatus(this.cachedStatus);
  }

  async startDeviceLogin() {
    if (process.env.CODEX_ENABLED === '0') throw Object.assign(new Error('服务器未启用 Codex'), { status: 503 });
    this.cleanup();
    const active = [...this.logins.values()].find((item) => item.status === 'waiting');
    if (active) return publicLogin(active);

    const state = {
      id: randomUUID(), status: 'waiting', verificationUrl: '', userCode: '', message: '', error: '',
      createdAt: Date.now(), updatedAt: Date.now(), child: null, loginId: '', send: null, startupTimer: null,
    };
    const { command, args } = codexCommand(['app-server']);
    const child = this.spawnImpl(command, args, {
      windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    state.child = child;
    this.logins.set(state.id, state);

    const send = (message) => child.stdin?.write(`${JSON.stringify(message)}\n`);
    state.send = send;
    const fail = (error) => {
      if (state.status !== 'waiting') return;
      clearTimeout(state.startupTimer);
      state.status = 'failed';
      state.error = String(error?.message || error || 'Codex 登录失败');
      state.updatedAt = Date.now();
      state.child = null;
      this.cachedStatus = null;
      terminateChild(child);
    };
    let stdout = '';
    const handle = (message) => {
      if (message.id === 0) {
        if (message.error) { fail(message.error.message); return; }
        send({ method: 'initialized', params: {} });
        send({ method: 'account/login/start', id: 1, params: { type: 'chatgptDeviceCode' } });
        return;
      }
      if (message.id === 1) {
        if (message.error) { fail(message.error.message); return; }
        const result = message.result || {};
        if (!result.loginId || !result.verificationUrl || !result.userCode) {
          fail('Codex app-server 未返回完整设备码');
          return;
        }
        clearTimeout(state.startupTimer);
        state.loginId = String(result.loginId);
        state.verificationUrl = String(result.verificationUrl);
        state.userCode = String(result.userCode).toUpperCase();
        state.message = '设备码已生成，等待授权。';
        state.updatedAt = Date.now();
        return;
      }
      if (message.id != null && message.error) {
        fail(message.error.message || 'Codex app-server 请求失败');
        return;
      }
      if (message.method !== 'account/login/completed') return;
      const params = message.params || {};
      if (state.loginId && params.loginId && params.loginId !== state.loginId) return;
      clearTimeout(state.startupTimer);
      state.status = params.success ? 'completed' : 'failed';
      state.error = params.success ? '' : String(params.error || 'Codex 登录未完成');
      state.updatedAt = Date.now();
      state.child = null;
      this.cachedStatus = null;
      terminateChild(child);
    };
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      let newline;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        try { handle(JSON.parse(line)); } catch { /* ignore non-protocol diagnostics */ }
      }
    });
    child.stderr?.on('data', (chunk) => {
      state.message = appendBounded(state.message, chunk, 6_000);
      state.updatedAt = Date.now();
    });
    child.on('error', (error) => fail(error?.code === 'ENOENT' ? '服务器未安装 Codex CLI' : error));
    child.on('close', (code) => {
      if (state.status !== 'waiting') return;
      fail(cleanLoginMessage(state.message) || `Codex 登录进程退出码 ${code}`);
    });
    state.startupTimer = setTimeout(() => fail('获取 Codex 设备码超时，请检查服务器代理后重试'), this.loginStartTimeoutMs);
    state.startupTimer.unref?.();
    send({
      method: 'initialize', id: 0,
      params: {
        clientInfo: { name: 'paper_graph', title: 'Paper Graph', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      },
    });
    return publicLogin(state);
  }

  getLogin(id) {
    this.cleanup();
    const state = this.logins.get(String(id || ''));
    if (!state) throw Object.assign(new Error('Codex 登录会话不存在或已过期'), { status: 404 });
    return publicLogin(state);
  }

  cancelLogin(id) {
    const state = this.logins.get(String(id || ''));
    if (!state) return;
    if (state.status === 'waiting') {
      clearTimeout(state.startupTimer);
      if (state.loginId) {
        try { state.send?.({ method: 'account/login/cancel', id: 2, params: { loginId: state.loginId } }); }
        catch { /* process may already be closing */ }
      }
      state.status = 'cancelled';
      state.updatedAt = Date.now();
      const child = state.child;
      const timer = setTimeout(() => terminateChild(child), 250);
      timer.unref?.();
      state.child = null;
    }
  }

  cleanup() {
    const cutoff = Date.now() - LOGIN_TTL_MS;
    for (const [id, state] of this.logins) {
      if (state.createdAt >= cutoff) continue;
      clearTimeout(state.startupTimer);
      terminateChild(state.child);
      this.logins.delete(id);
    }
  }
}

async function captureCodex(args, spawnImpl) {
  const { command, args: commandArgs } = codexCommand(args);
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawnImpl(command, commandArgs, {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' },
    });
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => { terminateChild(child); finish(-1); }, COMMAND_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.on('error', (error) => { stderr = String(error?.message || error); finish(-1); });
    child.on('close', finish);
  });
}

function codexCommand(args) {
  if (process.platform !== 'win32' || process.env.CODEX_BIN) return { command: process.env.CODEX_BIN || 'codex', args };
  return {
    command: process.execPath,
    args: [path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), ...args],
  };
}

function publicStatus(value) {
  const { enabled, authenticated, authMethod = '', version = '', message = '' } = value;
  return { enabled, authenticated, authMethod, version, message };
}

function publicLogin(state) {
  return {
    id: state.id, status: state.status, verificationUrl: state.verificationUrl, userCode: state.userCode,
    message: cleanLoginMessage(state.message), error: state.error,
  };
}

function cleanLoginMessage(value) {
  return String(value || '').replace(/\u001b\[[0-9;]*m/g, '').trim().slice(-3_000);
}

function firstLine(value) { return String(value || '').trim().split(/\r?\n/)[0] || ''; }
function appendBounded(current, chunk, limit = 12_000) { return `${current}${chunk}`.slice(-limit); }
function terminateChild(child) {
  if (!child) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch { /* process already exited */ }
}
