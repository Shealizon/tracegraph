import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const REGION_ERROR = /unsupported_country_region_territory|country, region, or territory not supported/i;
const DEFAULT_DISCOVERY_TIMEOUT = 25_000;
const DEFAULT_TASK_TIMEOUT = 10 * 60_000;

export async function discoverCodexModels(options = {}) {
  if (process.env.CODEX_ENABLED === '0') throw new Error('服务器未启用 Codex');
  const startedAt = Date.now();
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_DISCOVERY_TIMEOUT);
  const child = spawnCodex(['app-server'], options.spawnImpl);

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let initialized = false;
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Codex 模型列表获取超时')), timeoutMs);
    timer.unref?.();

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminateChild(child);
      if (error) reject(error);
      else resolve({ models: normalizeCodexModels(value?.data), latencyMs: Date.now() - startedAt });
    };

    const readLines = () => {
      let newline;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 0 && message.result && !initialized) {
          initialized = true;
          child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ method: 'model/list', id: 1, params: { limit: 100, includeHidden: false } })}\n`);
        } else if (message.id === 1) {
          if (message.error) finish(new Error(message.error.message || 'Codex 模型列表获取失败'));
          else finish(null, message.result);
        }
      }
    };

    child.stdout.on('data', (chunk) => { stdout += chunk; readLines(); });
    child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.on('error', (error) => finish(commandError(error)));
    child.on('close', (code) => {
      if (!settled) finish(new Error(formatCodexFailure(stderr, `Codex app-server 退出码 ${code}`)));
    });
    child.stdin.on('error', () => {});
    child.stdin.write(`${JSON.stringify({
      method: 'initialize', id: 0,
      params: { clientInfo: { name: 'paper_graph', title: 'Paper Graph', version: '0.1.0' } },
    })}\n`);
  });
}

export async function executeCodex({ prompt, cwd, model = '', signal, timeoutMs, spawnImpl } = {}) {
  if (process.env.CODEX_ENABLED === '0') throw new Error('服务器未启用 Codex');
  if (signal?.aborted) throw abortError(signal.reason);
  const outputPath = path.join(cwd, '.paper-graph-codex-output.md');
  const args = buildCodexExecArgs({ model, outputPath });
  const child = spawnCodex(args, spawnImpl, cwd);
  const limit = positiveNumber(timeoutMs ?? process.env.CODEX_TASK_TIMEOUT_MS, DEFAULT_TASK_TIMEOUT);

  try {
    return await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let lastAgentMessage = '';
      let settled = false;
      const timer = setTimeout(() => finish(new Error(`Codex 任务超过 ${Math.round(limit / 60_000)} 分钟，已自动终止`)), limit);
      timer.unref?.();

      const finish = async (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) {
          terminateChild(child);
          reject(error);
          return;
        }
        try {
          const fileOutput = await fs.readFile(outputPath, 'utf8').catch(() => '');
          const output = fileOutput.trim() || lastAgentMessage.trim();
          if (!output) throw new Error('Codex 未返回最终回答');
          resolve(output);
        } catch (readError) { reject(readError); }
      };

      const parseEvents = () => {
        let newline;
        while ((newline = stdout.indexOf('\n')) >= 0) {
          const line = stdout.slice(0, newline).trim();
          stdout = stdout.slice(newline + 1);
          if (!line) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === 'item.completed' && event.item?.type === 'agent_message') lastAgentMessage = event.item.text || lastAgentMessage;
            if (event.type === 'turn.failed' || event.type === 'error') {
              const message = event.error?.message || event.message || '未知 Codex 错误';
              finish(new Error(formatCodexFailure(`${stderr}\n${message}`, message)));
            }
          } catch { /* ignore non-JSON diagnostic lines */ }
        }
      };
      const onAbort = () => finish(abortError(signal.reason));

      child.stdout.on('data', (chunk) => { stdout += chunk; parseEvents(); });
      child.stderr.on('data', (chunk) => {
        stderr = appendBounded(stderr, chunk);
        if (REGION_ERROR.test(stderr)) finish(new Error(formatCodexFailure(stderr)));
      });
      child.on('error', (error) => finish(commandError(error)));
      child.on('close', (code) => {
        if (settled) return;
        if (code === 0) finish();
        else finish(new Error(formatCodexFailure(stderr, `Codex 退出码 ${code}`)));
      });
      child.stdin.on('error', (error) => finish(error));
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdin.end(String(prompt || ''));
    });
  } finally {
    await fs.rm(outputPath, { force: true }).catch(() => {});
  }
}

export function buildCodexExecArgs({ model = '', outputPath }) {
  const args = [
    'exec', '--skip-git-repo-check', '--ephemeral', '--color', 'never',
    '--sandbox', 'read-only', '--json', '--output-last-message', outputPath,
  ];
  const selected = String(model || '').trim();
  if (selected && selected !== 'codex') args.push('--model', selected);
  args.push('-');
  return args;
}

export function normalizeCodexModels(models) {
  return (Array.isArray(models) ? models : [])
    .filter((item) => item && !item.hidden && (item.model || item.id))
    .map((item) => ({
      id: String(item.model || item.id),
      displayName: String(item.displayName || item.model || item.id),
      description: String(item.description || ''),
      isDefault: Boolean(item.isDefault),
      defaultReasoningEffort: String(item.defaultReasoningEffort || ''),
      supportedReasoningEfforts: (item.supportedReasoningEfforts || []).map((effort) => String(effort.reasoningEffort || effort)).filter(Boolean),
    }));
}

export function formatCodexFailure(value, fallback = 'Codex 执行失败') {
  const text = String(value || '');
  if (REGION_ERROR.test(text)) return '服务器当前出口网络不在 Codex 支持的地区，请为服务配置受支持地区的 HTTPS_PROXY 后重试';
  return text.trim().slice(-2_000) || fallback;
}

function spawnCodex(args, spawnImpl = spawn, cwd) {
  let command = process.env.CODEX_BIN || 'codex';
  let commandArgs = args;
  if (process.platform === 'win32' && !process.env.CODEX_BIN) {
    command = process.execPath;
    commandArgs = [path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), ...args];
  }
  return spawnImpl(command, commandArgs, {
    cwd, windowsHide: true, detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' },
  });
}

function terminateChild(child) {
  try { child.stdin?.end(); } catch { /* already closed */ }
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch { /* already exited */ }
  const killer = setTimeout(() => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { /* already exited */ }
  }, 1_500);
  killer.unref?.();
}

function appendBounded(current, chunk) { return `${current}${chunk}`.slice(-12_000); }
function positiveNumber(value, fallback) { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : fallback; }
function abortError(reason) { const error = reason instanceof Error ? reason : new Error('已取消 Codex 任务'); error.name = 'AbortError'; return error; }
function commandError(error) { return error?.code === 'ENOENT' ? new Error('服务器未安装 Codex CLI') : error; }
