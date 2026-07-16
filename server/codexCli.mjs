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

export async function executeCodexStream({ prompt, cwd, model = '', signal, timeoutMs, spawnImpl, onEvent } = {}) {
  if (process.env.CODEX_ENABLED === '0') throw new Error('服务器未启用 Codex');
  if (signal?.aborted) throw abortError(signal.reason);
  const child = spawnCodex(['app-server'], spawnImpl, cwd);
  const limit = positiveNumber(timeoutMs ?? process.env.CODEX_TASK_TIMEOUT_MS, DEFAULT_TASK_TIMEOUT);

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let output = '';
    let lastAgentMessage = '';
    let settled = false;
    let initialized = false;
    let threadId = '';
    const timer = setTimeout(() => finish(new Error(`Codex 任务超过 ${Math.round(limit / 60_000)} 分钟，已自动终止`)), limit);
    timer.unref?.();

    const send = (message) => {
      try { child.stdin.write(`${JSON.stringify(message)}\n`); }
      catch (error) { finish(error); }
    };
    const emit = (event) => {
      try { onEvent?.(event); } catch { /* progress callbacks cannot stop the Codex process */ }
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      terminateChild(child);
      if (error) reject(error);
      else {
        const finalOutput = output.trim() || lastAgentMessage.trim();
        if (!finalOutput) reject(new Error('Codex 未返回最终回答'));
        else resolve(finalOutput);
      }
    };
    const handle = (message) => {
      if (message.id === 0 && message.result && !initialized) {
        initialized = true;
        send({ method: 'initialized', params: {} });
        send({
          method: 'thread/start', id: 1,
          params: {
            cwd, model: String(model || '').trim() || undefined, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true,
            config: { model_reasoning_summary: 'auto', hide_agent_reasoning: false, show_raw_agent_reasoning: false },
          },
        });
        return;
      }
      if (message.id === 1 && message.result?.thread?.id) {
        threadId = message.result.thread.id;
        send({ method: 'turn/start', id: 2, params: { threadId, input: [{ type: 'text', text: String(prompt || '') }], cwd, summary: 'auto' } });
        return;
      }
      if (message.id != null && message.error) {
        finish(new Error(message.error.message || 'Codex app-server 请求失败'));
        return;
      }
      if (message.id != null && message.method) {
        send({ id: message.id, result: { decision: 'decline' } });
        return;
      }
      const params = message.params || {};
      if (message.method === 'item/agentMessage/delta' && params.delta) {
        output += params.delta;
        emit({ type: 'text_delta', delta: params.delta, itemId: params.itemId || '' });
      } else if (message.method === 'item/reasoning/summaryTextDelta' && params.delta) {
        emit({ type: 'reasoning_delta', delta: params.delta, itemId: params.itemId || '' });
      } else if (message.method === 'item/commandExecution/outputDelta' && params.delta) {
        emit({ type: 'tool_delta', id: params.itemId || '', delta: params.delta });
      } else if (message.method === 'item/started' || message.method === 'item/completed') {
        const phase = message.method === 'item/started' ? 'running' : 'done';
        const event = normalizeCodexItemEvent(params.item, phase);
        if (event) emit(event);
        if (phase === 'done' && params.item?.type === 'agentMessage') lastAgentMessage = params.item.text || lastAgentMessage;
      } else if (message.method === 'turn/completed') {
        const turnError = params.turn?.error?.message || params.turn?.error;
        if (turnError) finish(new Error(String(turnError)));
        else finish();
      } else if (message.method === 'error' && params.error?.message && !params.willRetry) {
        finish(new Error(formatCodexFailure(params.error.message)));
      }
    };
    const readLines = () => {
      let newline;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        try { handle(JSON.parse(line)); } catch { /* ignore non-protocol diagnostics */ }
      }
    };
    const onAbort = () => finish(abortError(signal.reason));

    child.stdout.on('data', (chunk) => { stdout += chunk; readLines(); });
    child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.on('error', (error) => finish(commandError(error)));
    child.on('close', (code) => {
      if (!settled) finish(new Error(formatCodexFailure(stderr, `Codex app-server 退出码 ${code}`)));
    });
    child.stdin.on('error', (error) => finish(error));
    signal?.addEventListener('abort', onAbort, { once: true });
    send({
      method: 'initialize', id: 0,
      params: { clientInfo: { name: 'paper_graph', title: 'Paper Graph', version: '0.1.0' } },
    });
  });
}

export function normalizeCodexItemEvent(item, phase = 'running') {
  if (!item?.id || !item.type) return null;
  const status = phase === 'running' ? 'running' : item.status === 'failed' ? 'error' : 'done';
  if (item.type === 'commandExecution') return {
    type: 'tool', id: item.id, name: 'shell_command', status,
    args: { command: item.command || '', cwd: item.cwd || '' },
    result: phase === 'done' ? { output: item.aggregatedOutput || '', exitCode: item.exitCode, durationMs: item.durationMs } : undefined,
  };
  if (item.type === 'mcpToolCall') return {
    type: 'tool', id: item.id, name: item.tool || item.server || 'mcp_tool', status: item.error ? 'error' : status,
    args: item.arguments, result: item.result, error: item.error?.message || item.error,
  };
  if (item.type === 'dynamicToolCall') return {
    type: 'tool', id: item.id, name: item.tool || 'tool', status: item.success === false ? 'error' : status,
    args: item.arguments, result: item.contentItems,
  };
  if (item.type === 'webSearch') return {
    type: 'tool', id: item.id, name: 'web_search', status, args: { query: item.query || '', action: item.action || null },
  };
  if (item.type === 'fileChange') return {
    type: 'tool', id: item.id, name: 'apply_patch', status, args: { changes: item.changes || [] },
  };
  if (item.type === 'imageView') return { type: 'tool', id: item.id, name: 'view_image', status, args: { path: item.path || '' } };
  if (item.type === 'imageGeneration') return { type: 'tool', id: item.id, name: 'image_generation', status, args: {}, result: item.result };
  if (item.type === 'plan') return { type: 'tool', id: item.id, name: 'update_plan', status, args: { plan: item.text || '' } };
  return null;
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
