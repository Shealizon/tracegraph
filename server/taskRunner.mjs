import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { randomId } from './security.mjs';
import { httpError } from './userStore.mjs';
import { discoverCodexModels, executeCodexStream } from './codexCli.mjs';
import { persistArtifacts } from './extensionRegistry.mjs';
import { isRetryableStreamError, streamCompletion } from '../src/ai/modelClient.js';
import { canonicalSourceKey, openUrl, resolveDoi, webSearch } from '../src/ai/tools.js';
import { executeGraphTool, graphToolDefinitions, isGraphTool } from '../src/ai/graphContext.js';
import { compileProject } from '../src/project/projectAdapter.js';

const MAX_WORKSPACE_FILE_BYTES = 20 * 1024 * 1024;
const SYNTHETIC_WORKSPACE_PATHS = new Set(['project.paper-graph.json']);
const PROVIDER_STREAM_RETRY_DELAYS = [800, 1_600, 3_200];

export class TaskRunner {
  constructor(userStore, extensions = null) {
    this.userStore = userStore;
    this.extensions = extensions;
    this.codexQueue = Promise.resolve();
    this.controllers = new Map();
    this.liveTasks = new Map();
    this.taskListeners = new Map();
    this.taskNotifyTimers = new Map();
    this.recoveredUsers = new Set();
    this.startedAt = Date.now();
    this.codexModelCache = null;
    this.codexModelRequest = null;
  }

  async create(session, input) {
    await this.recoverInterrupted(session);
    const id = randomId('task_');
    const now = new Date().toISOString();
    const task = {
      id, type: 'ai', kind: input.kind === 'compaction' ? 'compaction' : 'chat', status: 'queued', providerId: input.providerId, model: input.model || '',
      projectId: input.projectId || '', conversationId: input.conversationId || '',
      workspaceScope: input.workspaceScope || `${input.projectId || 'default'}--${input.conversationId || 'default'}`,
      input: {
        history: input.history || [],
        userText: String(input.userText || ''),
        systemPrompt: String(input.systemPrompt || ''),
        fileAccessMode: ['read-only', 'ask', 'allow'].includes(input.fileAccessMode) ? input.fileAccessMode : 'ask',
      },
      output: '', blocks: [], error: '', createdAt: now, updatedAt: now,
    };
    if (!task.input.userText.trim()) throw httpError(400, '消息不能为空');
    await this.userStore.updateVault(session, (vault) => { vault.tasks[id] = task; });
    const worker = task.providerId === 'server-codex'
      ? () => this.runCodex(session, task)
      : () => this.runProvider(session, task);
    if (task.providerId === 'server-codex') {
      this.codexQueue = this.codexQueue.catch(() => {}).then(worker);
    } else {
      queueMicrotask(() => worker().catch(() => {}));
    }
    return sanitizeTask(task);
  }

  async list(session, { projectId = '', conversationId = '' } = {}) {
    await this.recoverInterrupted(session);
    const vault = await this.userStore.readVault(session);
    return Object.values(vault.tasks || {}).map((task) => this.liveTasks.get(`${session.userId}:${task.id}`) || task)
      .filter((task) => !projectId || task.projectId === projectId)
      .filter((task) => !conversationId || task.conversationId === conversationId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map(sanitizeTask);
  }

  async get(session, id) {
    await this.recoverInterrupted(session);
    const live = this.liveTasks.get(`${session.userId}:${id}`);
    if (live) return sanitizeTask(live);
    const vault = await this.userStore.readVault(session);
    const task = vault.tasks?.[id];
    if (!task) throw httpError(404, '任务不存在');
    return sanitizeTask(task);
  }

  async cancel(session, id) {
    const key = `${session.userId}:${id}`;
    const live = this.liveTasks.get(key);
    if (live) { live.status = 'cancelled'; live.updatedAt = new Date().toISOString(); }
    if (live) this.notifyTask(session, live, { immediate: true });
    this.controllers.get(key)?.abort();
    await this.patch(session, id, { status: 'cancelled', updatedAt: new Date().toISOString() });
    return this.get(session, id);
  }

  async subscribe(session, id, listener) {
    const task = await this.get(session, id);
    const key = `${session.userId}:${id}`;
    const listeners = this.taskListeners.get(key) || new Set();
    listeners.add(listener);
    this.taskListeners.set(key, listeners);
    listener(task);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.taskListeners.delete(key);
    };
  }

  notifyTask(session, task, { immediate = false } = {}) {
    const key = `${session.userId}:${task.id}`;
    const emit = () => {
      this.taskNotifyTimers.delete(key);
      const snapshot = sanitizeTask(task);
      for (const listener of this.taskListeners.get(key) || []) {
        try { listener(snapshot); } catch { /* disconnected listeners are cleaned up by the route */ }
      }
    };
    if (immediate) {
      clearTimeout(this.taskNotifyTimers.get(key));
      emit();
      return;
    }
    if (this.taskNotifyTimers.has(key)) return;
    const timer = setTimeout(emit, 50);
    timer.unref?.();
    this.taskNotifyTimers.set(key, timer);
  }

  async runProvider(session, task) {
    const controller = new AbortController();
    const liveKey = `${session.userId}:${task.id}`;
    this.controllers.set(liveKey, controller);
    task.status = 'running';
    task.streamStatus = 'streaming';
    task.progressVersion = Number(task.progressVersion || 0) + 1;
    this.liveTasks.set(liveKey, task);
    let progressTimer = null;
    let progressWrites = Promise.resolve();
    const flushProgress = () => {
      clearTimeout(progressTimer);
      progressTimer = null;
      const snapshot = {
        output: task.output,
        blocks: structuredClone(task.blocks || []),
        streamStatus: task.streamStatus,
        retryAttempt: task.retryAttempt || 0,
        progressVersion: task.progressVersion || 0,
        updatedAt: new Date().toISOString(),
      };
      progressWrites = progressWrites.catch(() => {}).then(() => this.patch(session, task.id, snapshot));
      return progressWrites;
    };
    const scheduleProgress = () => {
      if (progressTimer) return;
      progressTimer = setTimeout(() => { flushProgress().catch(() => {}); }, 1_200);
      progressTimer.unref?.();
    };
    try {
      await this.patch(session, task.id, { status: 'running', updatedAt: new Date().toISOString() });
      const vault = await this.userStore.readVault(session);
      const provider = Object.hasOwn(vault.providers || {}, task.providerId) ? vault.providers[task.providerId] : null;
      if (!provider) throw new Error('云端模型服务不存在，请重新保存服务商配置');
      const workspaceChanges = {
        committed: task.input.fileAccessMode === 'allow',
        created: [],
        modified: [],
        deleted: [],
        skipped: [],
        conflicts: [],
      };
      const output = await callProvider(provider, task, controller.signal, vault, {
        extensions: this.extensions,
        userStore: this.userStore,
        session,
        fileAccessMode: task.input.fileAccessMode,
        workspaceChanges,
        onEvent: (event) => {
          applyCodexProgress(task, event);
          this.notifyTask(session, task);
          scheduleProgress();
        },
        onStatus: (event) => {
          task.streamStatus = event.type;
          task.retryAttempt = event.attempt || 0;
          task.progressVersion = Number(task.progressVersion || 0) + 1;
          task.updatedAt = new Date().toISOString();
          this.notifyTask(session, task);
          scheduleProgress();
        },
      });
      if (progressTimer) await flushProgress();
      else await progressWrites;
      task.output = output;
      task.workspaceChanges = workspaceChanges;
      task.streamStatus = 'completed';
      syncFinalTextBlock(task);
      task.status = 'completed';
      await this.patch(session, task.id, {
        status: 'completed',
        output: task.output,
        blocks: task.blocks,
        streamStatus: task.streamStatus,
        retryAttempt: 0,
        progressVersion: task.progressVersion || 0,
        workspaceChanges,
        updatedAt: new Date().toISOString(),
      });
      this.notifyTask(session, task, { immediate: true });
    } catch (error) {
      clearTimeout(progressTimer);
      await progressWrites.catch(() => {});
      const status = controller.signal.aborted || error?.name === 'AbortError' ? 'cancelled' : 'failed';
      task.status = status;
      task.streamStatus = status;
      task.error = error?.message || String(error);
      await this.patch(session, task.id, {
        status,
        output: task.output,
        blocks: task.blocks,
        streamStatus: task.streamStatus,
        retryAttempt: task.retryAttempt || 0,
        progressVersion: task.progressVersion || 0,
        error: task.error,
        updatedAt: new Date().toISOString(),
      });
      this.notifyTask(session, task, { immediate: true });
    } finally {
      this.controllers.delete(liveKey);
      this.liveTasks.delete(liveKey);
    }
  }

  async runCodex(session, task) {
    if (process.env.CODEX_ENABLED === '0') {
      await this.patch(session, task.id, { status: 'failed', error: '服务器未启用 Codex', updatedAt: new Date().toISOString() });
      return;
    }
    const latest = await this.get(session, task.id);
    if (latest.status === 'cancelled') return;
    const controller = new AbortController();
    const liveKey = `${session.userId}:${task.id}`;
    this.controllers.set(liveKey, controller);
    await this.patch(session, task.id, { status: 'running', updatedAt: new Date().toISOString() });
    task.status = 'running';
    this.liveTasks.set(liveKey, task);
    let tempDir = '';
    let progressTimer = null;
    let progressWrites = Promise.resolve();
    const flushProgress = () => {
      clearTimeout(progressTimer);
      progressTimer = null;
      const snapshot = { output: task.output, blocks: structuredClone(task.blocks || []), updatedAt: new Date().toISOString() };
      progressWrites = progressWrites.catch(() => {}).then(() => this.patch(session, task.id, snapshot));
      return progressWrites;
    };
    const scheduleProgress = () => {
      if (progressTimer) return;
      progressTimer = setTimeout(() => { flushProgress().catch(() => {}); }, 1_500);
      progressTimer.unref?.();
    };
    try {
      const vault = await this.userStore.readVault(session);
      tempDir = await materializeCodexWorkspace(vault, task);
      const initialWorkspaceFiles = Object.values(vault.files || {})
        .filter((item) => item.scope === task.workspaceScope)
        .map((item) => ({ ...item }));
      const workspaceFiles = initialWorkspaceFiles.map((item) => ({ ...item }));
      const prompt = [
        '当前目录是该用户此次任务的临时可写工作区快照；项目数据位于 project.paper-graph.json，附件保持原工作区相对路径。读写操作仅限当前目录。',
        task.kind === 'compaction' ? '当前任务只需压缩对话上下文，不要调用任何工具。' : '',
        task.input.fileAccessMode === 'allow'
          ? '当前对话允许写入。你可以用 shell 或 apply_patch 在当前目录创建、修改或删除文件；任务成功后系统会把这些差异提交到对话的持久工作区。最终回复请引用工作区相对路径，不要引用 /tmp 等临时绝对路径。'
          : '当前对话未授予持久写入权限；不要生成、修改或删除用户文件，因为临时目录中的改动不会提交到工作区。',
        this.extensions?.skillPrompt(),
        task.input.systemPrompt,
        ...task.input.history.map((m) => `${m.role}: ${m.content}`),
        `user: ${task.input.userText}`,
      ].filter(Boolean).join('\n\n');
      const output = await executeCodexStream({
        prompt, cwd: tempDir, model: task.model, signal: controller.signal,
        dynamicTools: task.kind === 'compaction'
          ? []
          : this.extensions?.dynamicTools({ includeWrites: task.input.fileAccessMode === 'allow' }) || [],
        onDynamicToolCall: async (name, args) => {
          if (!this.extensions?.findTool(name)) throw new Error(`扩展工具不存在：${name}`);
          const execution = await this.extensions.execute(name, args, {
            workspaceFiles,
            workspaceScope: task.workspaceScope,
            projectId: task.projectId,
            signal: controller.signal,
            allowWrites: task.input.fileAccessMode === 'allow',
          });
          const artifacts = await persistArtifacts(this.userStore, session, task.workspaceScope, execution);
          for (const artifact of execution.artifacts) {
            workspaceFiles.push({ ...artifact, scope: task.workspaceScope });
            const target = path.resolve(tempDir, artifact.path);
            if (target.startsWith(`${path.resolve(tempDir)}${path.sep}`)) {
              await fs.mkdir(path.dirname(target), { recursive: true });
              await fs.writeFile(target, Buffer.from(artifact.data, 'base64'));
            }
          }
          return { ...execution.result, artifacts };
        },
        onEvent: (event) => {
          applyCodexProgress(task, event);
          this.notifyTask(session, task);
          scheduleProgress();
        },
      });
      if (progressTimer) await flushProgress();
      else await progressWrites;
      const workspaceChanges = task.input.fileAccessMode === 'allow'
        ? await persistCodexWorkspaceChanges(this.userStore, session, task.workspaceScope, tempDir, initialWorkspaceFiles)
        : { committed: false, created: [], modified: [], deleted: [], skipped: [], conflicts: [] };
      console.info('[codex-workspace]', JSON.stringify({
        taskId: task.id,
        scope: task.workspaceScope,
        fileAccessMode: task.input.fileAccessMode,
        committed: workspaceChanges.committed,
        created: workspaceChanges.created,
        modified: workspaceChanges.modified,
        deleted: workspaceChanges.deleted,
        skipped: workspaceChanges.skipped,
        conflicts: workspaceChanges.conflicts,
      }));
      task.output = output;
      task.workspaceChanges = workspaceChanges;
      syncFinalTextBlock(task);
      task.status = 'completed';
      await this.patch(session, task.id, {
        status: 'completed',
        output: task.output,
        blocks: task.blocks,
        workspaceChanges,
        updatedAt: new Date().toISOString(),
      });
      this.notifyTask(session, task, { immediate: true });
    } catch (error) {
      clearTimeout(progressTimer);
      await progressWrites.catch(() => {});
      const status = controller.signal.aborted || error?.name === 'AbortError' ? 'cancelled' : 'failed';
      task.status = status;
      task.error = error?.message || String(error);
      await this.patch(session, task.id, { status, output: task.output, blocks: task.blocks, error: error?.message || String(error), updatedAt: new Date().toISOString() });
      this.notifyTask(session, task, { immediate: true });
    } finally {
      this.controllers.delete(liveKey);
      this.liveTasks.delete(liveKey);
      if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async listCodexModels({ force = false } = {}) {
    if (!force && this.codexModelCache && Date.now() - this.codexModelCache.cachedAt < 10 * 60_000) return this.codexModelCache;
    if (this.codexModelRequest) return this.codexModelRequest;
    this.codexModelRequest = discoverCodexModels().then((result) => {
      this.codexModelCache = { ...result, cachedAt: Date.now() };
      return this.codexModelCache;
    }).finally(() => { this.codexModelRequest = null; });
    return this.codexModelRequest;
  }

  async recoverInterrupted(session) {
    if (this.recoveredUsers.has(session.userId)) return;
    await this.userStore.updateVault(session, (vault) => {
      for (const task of Object.values(vault.tasks || {})) {
        if (!['queued', 'running'].includes(task.status) || Date.parse(task.updatedAt || task.createdAt || 0) >= this.startedAt) continue;
        task.status = 'failed';
        task.error = '服务器重启中断了该任务，请重试';
        task.updatedAt = new Date().toISOString();
      }
    });
    this.recoveredUsers.add(session.userId);
  }

  patch(session, id, patch) {
    return this.userStore.updateVault(session, (vault) => {
      if (!vault.tasks?.[id]) throw httpError(404, '任务不存在');
      Object.assign(vault.tasks[id], patch);
    });
  }
}

export function applyCodexProgress(task, event) {
  if (!event) return task;
  task.progressVersion = Number(task.progressVersion || 0) + 1;
  task.updatedAt = new Date().toISOString();
  task.blocks ||= [];
  if (event.type === 'text_delta' && event.delta) {
    task.output = `${task.output || ''}${event.delta}`;
    let block = task.blocks.at(-1);
    if (!block || block.type !== 'text') { block = { type: 'text', content: '' }; task.blocks.push(block); }
    block.content += event.delta;
  } else if (event.type === 'reasoning_delta' && event.delta) {
    let block = task.blocks.at(-1);
    if (!block || block.type !== 'reasoning') { block = { type: 'reasoning', content: '' }; task.blocks.push(block); }
    block.content += event.delta;
  } else if (event.type === 'tool') {
    let block = task.blocks.find((item) => item.type === 'tool' && item.key === event.id);
    if (!block) {
      block = { type: 'tool', key: event.id, name: event.name, args: event.args, status: 'running' };
      task.blocks.push(block);
    }
    block.status = event.status || block.status;
    if (event.args !== undefined) block.args = event.args;
    if (event.result !== undefined) block.result = event.result;
    if (event.error) block.error = typeof event.error === 'string' ? event.error : JSON.stringify(event.error);
  } else if (event.type === 'tool_delta' && event.id) {
    const block = task.blocks.find((item) => item.type === 'tool' && item.key === event.id);
    if (block) {
      const current = block.result && typeof block.result === 'object' ? block.result : {};
      block.result = { ...current, output: `${current.output || ''}${event.delta || ''}` };
    }
  }
  if (task.blocks.length > 120) task.blocks = task.blocks.slice(-120);
  return task;
}

function syncFinalTextBlock(task) {
  const textBlocks = (task.blocks || []).filter((block) => block.type === 'text');
  const blockText = textBlocks.map((block) => block.content || '').join('');
  if (blockText === task.output) return;
  if (!textBlocks.length) task.blocks.push({ type: 'text', content: task.output || '' });
  else textBlocks.at(-1).content += String(task.output || '').slice(blockText.length);
}

export async function callProvider(provider, task, signal, vault, extensionContext = {}) {
  const config = {
    protocol: provider.protocol || 'openai-chat',
    baseUrl: String(provider.baseUrl || '').replace(/\/+$/, ''),
    apiKey: provider.apiKey,
    model: task.model || provider.model,
  };
  const messages = [
    ...(extensionContext.extensions?.skillPrompt() ? [{ role: 'system', content: extensionContext.extensions.skillPrompt() }] : []),
    ...(extensionContext.fileAccessMode === 'allow'
      ? [{ role: 'system', content: '当前对话允许持久写入文本文件。需要创建或更新 Markdown、TXT、JSON、CSV、代码等文本内容时，直接调用 write_file；写入成功后不要声称缺少文件创建工具。' }]
      : []),
    ...(task.input.systemPrompt ? [{ role: 'system', content: task.input.systemPrompt }] : []),
    ...task.input.history.filter((m) => ['user', 'assistant'].includes(m.role)).map((m) => ({ role: m.role, content: String(m.content || '') })),
    { role: 'user', content: task.input.userText },
  ];
  const serverTools = createServerTools(vault, task.projectId, task.workspaceScope, {
    ...extensionContext,
    signal,
    fileAccessMode: task.input.fileAccessMode,
  });
  const availableTools = task.kind === 'compaction' ? [] : serverTools.definitions;
  let collected = '';
  for (let round = 0; round < 8; round += 1) {
    const response = await streamProviderRound(config, messages, availableTools, {
      signal,
      onStatus: extensionContext.onStatus,
      onDelta: (delta) => {
        collected += delta;
        extensionContext.onEvent?.({ type: 'text_delta', delta });
      },
      onReasoningDelta: (delta) => extensionContext.onEvent?.({ type: 'reasoning_delta', delta }),
    });
    if (!response.toolCalls.length) return collected || response.content || '';
    const calls = response.toolCalls.map((call) => ({ ...call, id: call.id || randomId('tool_') }));
    messages.push({
      role: 'assistant',
      content: response.content || null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments || '{}' },
      })),
    });
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.arguments || '{}'); } catch { /* malformed arguments become empty */ }
      const id = call.id;
      extensionContext.onEvent?.({ type: 'tool', id, name: call.name, status: 'running', args });
      let content;
      try {
        content = await serverTools.execute(call.name, args);
        extensionContext.onEvent?.({ type: 'tool', id, name: call.name, status: 'done', args, result: content });
      } catch (error) {
        content = { error: error?.message || String(error) };
        extensionContext.onEvent?.({ type: 'tool', id, name: call.name, status: 'error', args, error: content.error });
      }
      messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(content) });
    }
  }
  throw new Error('模型工具调用轮次过多');
}

async function streamProviderRound(config, messages, tools, { signal, onDelta, onReasoningDelta, onStatus } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    let emitted = false;
    try {
      onStatus?.({ type: 'streaming', attempt });
      return await streamCompletion(config, messages, tools, (delta) => {
        emitted = true;
        onDelta?.(delta);
      }, (delta) => {
        emitted = true;
        onReasoningDelta?.(delta);
      }, signal);
    } catch (error) {
      if (signal?.aborted || emitted || !isRetryableStreamError(error) || attempt >= PROVIDER_STREAM_RETRY_DELAYS.length) throw error;
      const delay = PROVIDER_STREAM_RETRY_DELAYS[attempt];
      onStatus?.({
        type: 'reconnecting',
        attempt: attempt + 1,
        maxAttempts: PROVIDER_STREAM_RETRY_DELAYS.length,
        delay,
        error: error?.message || String(error),
      });
      await waitForProviderRetry(delay, signal);
    }
  }
}

function waitForProviderRetry(delay, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delay);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function sanitizeTask(task) {
  const { input, ...safe } = task;
  return { ...safe, inputPreview: input?.userText?.slice(0, 160) || '' };
}

export function createServerTools(vault, projectId, workspaceScope, extensionContext = {}) {
  const allowExtensionWrites = !extensionContext.fileAccessMode || extensionContext.fileAccessMode === 'allow';
  const canPersistWorkspaceWrites = allowExtensionWrites && Boolean(extensionContext.userStore && extensionContext.session);
  const project = Object.hasOwn(vault.projects || {}, projectId) ? vault.projects[projectId] : null;
  const graphModel = project ? buildServerProjectGraphModel(project) : null;
  const nodes = graphModel?.nodes || [];
  const workspaceFiles = Object.values(vault.files || {}).filter((file) => file.scope === workspaceScope);
  const graphDefinitions = graphModel
    ? graphToolDefinitions().filter((definition) => [
      'graph_overview',
      'search_graph_nodes',
      'get_graph_node',
      'get_graph_nodes',
      'get_graph_neighbors',
      'get_graph_neighbors_batch',
      'locate_graph_reference',
      'list_tag_notes',
      'get_tag_note',
    ].includes(definition.function.name))
    : [];
  const knownSources = new Map();
  let sourceNumber = 0;
  const registerSource = (source) => {
    const key = canonicalSourceKey(source);
    const existing = key ? knownSources.get(key) : null;
    if (existing) return { source: existing, isNew: false };
    const registered = { ...source, citation: `[S${++sourceNumber}]` };
    if (key) knownSources.set(key, registered);
    return { source: registered, isNew: true };
  };
  const definitions = [
    toolDefinition('get_project_summary', '读取当前项目、文档和图谱规模摘要。', { type: 'object', properties: {}, additionalProperties: false }),
    toolDefinition('search_graph', '在当前项目的节点标题、正文和 ID 中搜索。', { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 30 } }, required: ['query'], additionalProperties: false }),
    ...graphDefinitions,
    toolDefinition('list_workspace', '列出当前对话已上传到云端工作区的文件。', { type: 'object', properties: {}, additionalProperties: false }),
    toolDefinition('read_file', '读取云端工作区中的 UTF-8 文本文件。', { type: 'object', properties: { path: { type: 'string' }, max_chars: { type: 'integer', minimum: 1000, maximum: 250000 } }, required: ['path'], additionalProperties: false }),
    toolDefinition('search_files', '在当前对话的云端文本文件中搜索关键词。', { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'integer', minimum: 1, maximum: 30 } }, required: ['query'], additionalProperties: false }),
    toolDefinition('read_pdf', '在服务端解析云端工作区 PDF 的文字层，支持指定页码或读取最多 80 页。', {
      type: 'object',
      properties: {
        path: { type: 'string' },
        pages: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 80 },
        max_pages: { type: 'integer', minimum: 1, maximum: 80 },
        max_chars: { type: 'integer', minimum: 2000, maximum: 120000 },
      },
      required: ['path'],
      additionalProperties: false,
    }),
    toolDefinition('web_search', '搜索网页与公开学术文献索引，返回可引用的来源编号。', { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 8 } }, required: ['query'], additionalProperties: false }),
    toolDefinition('open_url', '读取一个明确的公开网页 URL，返回正文与可引用来源。', { type: 'object', properties: { url: { type: 'string' }, max_chars: { type: 'integer', minimum: 1000, maximum: 30000 } }, required: ['url'], additionalProperties: false }),
    toolDefinition('resolve_doi', '仅对明确出现的 DOI 精确获取 Crossref 论文元数据。', { type: 'object', properties: { doi: { type: 'string' } }, required: ['doi'], additionalProperties: false }),
    ...(canPersistWorkspaceWrites ? [toolDefinition(
      'write_file',
      '在当前对话的持久工作区创建或覆盖 UTF-8 文本文件。适用于 Markdown、TXT、JSON、CSV、TeX 和代码文件；用户已允许本对话直接写入。',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: '工作区相对路径，例如 notes/result.md' },
          content: { type: 'string', description: '需要写入的完整 UTF-8 文本内容' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    )] : []),
    ...(extensionContext.extensions?.definitions({ includeWrites: allowExtensionWrites }) || []),
  ];
  const execute = async (name, args) => {
    if (name === 'get_project_summary') return project ? {
      id: project.id, name: project.name, updatedAt: project.updatedAt,
      documents: (project.documents || []).map((document) => ({ id: document.id, name: document.name, nodes: document.graph?.nodes?.length || 0 })),
      nodeCount: nodes.length,
    } : { error: 'project_not_found' };
    if (name === 'search_graph') {
      const query = String(args.query || '').trim().toLowerCase();
      const limit = Math.max(1, Math.min(30, Number(args.limit) || 12));
      return nodes.filter((node) => nodeSearchText(node).includes(query)).slice(0, limit).map(nodePreview);
    }
    if (graphModel && isGraphTool(name)) return executeGraphTool(graphModel, name, args, {
      getGraphTags: () => project?.config?.tags || graphModel.tags || [],
      getGraphNotes: () => project?.config?.notes || [],
    });
    if (name === 'list_workspace') return { files: workspaceFiles.map(({ data, ...file }) => file) };
    if (name === 'read_file') {
      const file = workspaceFiles.find((item) => item.path === args.path);
      if (!file) return { error: 'file_not_found', path: args.path };
      if (!isTextFile(file)) return { error: 'binary_file', path: file.path, type: file.type, size: file.size };
      const content = Buffer.from(file.data || '', 'base64').toString('utf8');
      const maxChars = clampNumber(args.max_chars, 1_000, 250_000, 50_000);
      return { path: file.path, type: file.type, content: content.slice(0, maxChars), truncated: content.length > maxChars };
    }
    if (name === 'search_files') {
      const query = String(args.query || '').trim();
      if (!query) return { error: 'empty_query', query };
      const limit = clampNumber(args.max_results, 1, 30, 12);
      const results = searchWorkspaceTextFiles(workspaceFiles, query, limit);
      return { query, results };
    }
    if (name === 'read_pdf') {
      const file = workspaceFiles.find((item) => item.path === args.path);
      if (!file) return { error: 'file_not_found', path: args.path };
      if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.path)) return { error: 'not_pdf', path: file.path, type: file.type };
      return readPdfText(file, args);
    }
    if (name === 'web_search') {
      const result = await webSearch(args);
      return { ...result, results: result.results.map((source) => registerSource(source).source) };
    }
    if (name === 'open_url') return openUrl(args, registerSource);
    if (name === 'resolve_doi') return resolveDoi(args, registerSource);
    if (name === 'write_file') {
      if (!canPersistWorkspaceWrites) return { path: args.path, written: false, reason: '当前任务未获得持久写入权限' };
      const filePath = normalizeWorkspacePath(args.path);
      if (!isValidWorkspacePath(filePath)) return { path: args.path, written: false, reason: '无效的工作区路径' };
      const content = String(args.content ?? '');
      const buffer = Buffer.from(content, 'utf8');
      if (buffer.byteLength > MAX_WORKSPACE_FILE_BYTES) {
        return { path: filePath, written: false, reason: '单个文件不能超过 20 MB', size: buffer.byteLength };
      }
      const data = buffer.toString('base64');
      const existing = workspaceFiles.find((item) => item.path === filePath);
      const changed = !existing || String(existing.data || '') !== data;
      const file = {
        scope: workspaceScope,
        path: filePath,
        name: filePath.split('/').at(-1).slice(0, 180),
        type: workspaceMimeType(filePath),
        size: buffer.byteLength,
        updatedAt: new Date().toISOString(),
        data,
      };
      await extensionContext.userStore.updateVault(extensionContext.session, (currentVault) => {
        currentVault.files ||= {};
        currentVault.files[workspaceFileKey(workspaceScope, filePath)] = file;
      });
      upsertWorkspaceFile(workspaceFiles, file);
      if (changed) recordWorkspaceChange(extensionContext.workspaceChanges, filePath, existing ? 'modified' : 'created');
      return { path: filePath, written: true, chars: content.length, size: buffer.byteLength, type: file.type };
    }
    if (extensionContext.extensions?.findTool(name)) {
      const previousByPath = new Map(workspaceFiles.map((file) => [file.path, file]));
      const execution = await extensionContext.extensions.execute(name, args, {
        workspaceFiles,
        workspaceScope,
        projectId,
        signal: extensionContext.signal,
        allowWrites: allowExtensionWrites,
      });
      const artifacts = extensionContext.userStore && extensionContext.session
        ? await persistArtifacts(extensionContext.userStore, extensionContext.session, workspaceScope, execution)
        : execution.artifacts.map(({ data: _data, ...artifact }) => artifact);
      for (const artifact of execution.artifacts) {
        const previous = previousByPath.get(artifact.path);
        upsertWorkspaceFile(workspaceFiles, { ...artifact, scope: workspaceScope });
        if (!previous || String(previous.data || '') !== String(artifact.data || '')) {
          recordWorkspaceChange(extensionContext.workspaceChanges, artifact.path, previous ? 'modified' : 'created');
        }
      }
      return { ...execution.result, artifacts };
    }
    return { error: 'unknown_tool', name };
  };
  return { definitions, execute };
}

function toolDefinition(name, description, parameters) { return { type: 'function', function: { name, description, parameters } }; }
function nodeSearchText(node) { return JSON.stringify([node.id, node.title, node.type, node.sections, node.statementBody, node.proofBody]).toLowerCase(); }
function nodePreview(node) { return { id: node.id, title: node.title || '', type: node.type || '', number: node.number ?? '', documentName: node.documentName }; }
function isTextFile(file) { return /^text\//.test(file.type || '') || /\.(md|txt|tex|csv|json|js|ts|css|html)$/i.test(file.path || ''); }
function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}
function searchWorkspaceTextFiles(workspaceFiles, query, limit) {
  const needle = query.toLowerCase();
  const results = [];
  for (const file of workspaceFiles.filter(isTextFile)) {
    const text = Buffer.from(file.data || '', 'base64').toString('utf8');
    const lower = text.toLowerCase();
    let from = 0;
    while (results.length < limit) {
      const index = lower.indexOf(needle, from);
      if (index < 0) break;
      results.push({
        path: file.path,
        excerpt: text.slice(Math.max(0, index - 100), index + query.length + 180),
      });
      from = index + Math.max(1, query.length);
    }
    if (results.length >= limit) break;
  }
  return results;
}
function buildServerGraphModel(rawGraph) {
  const nodes = (rawGraph?.nodes || []).map((node) => ({ ...node }));
  const edges = (rawGraph?.edges || []).map((edge) => ({ ...edge }));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const labelIndex = new Map();
  const deps = new Map(nodes.map((node) => [node.id, new Set()]));
  const usedBy = new Map(nodes.map((node) => [node.id, new Set()]));
  for (const node of nodes) {
    for (const label of node.labels || []) labelIndex.set(label.id, { node, label });
  }
  for (const edge of edges) {
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue;
    deps.get(edge.to).add(edge.from);
    usedBy.get(edge.from).add(edge.to);
  }
  for (const node of nodes) {
    node.degIn = deps.get(node.id)?.size || 0;
    node.degOut = usedBy.get(node.id)?.size || 0;
    node.importance ||= Math.max(1, node.degIn + node.degOut);
  }
  return {
    meta: rawGraph?.meta || {},
    nodes,
    edges,
    tags: rawGraph?.tags || rawGraph?.meta?.tags || [],
    nodeById,
    labelIndex,
    deps,
    usedBy,
  };
}
function buildServerProjectGraphModel(project) {
  try {
    return buildServerGraphModel(compileProject(project));
  } catch {
    return buildServerGraphModel({
      meta: { title: project?.name || '' },
      nodes: (project?.documents || []).flatMap((document) => (document.graph?.nodes || [])
        .map((node) => ({ ...node, documentId: document.id, documentName: document.name }))),
      edges: (project?.documents || []).flatMap((document) => document.graph?.edges || []),
    });
  }
}
function upsertWorkspaceFile(workspaceFiles, file) {
  const index = workspaceFiles.findIndex((item) => item.path === file.path);
  if (index >= 0) workspaceFiles[index] = file;
  else workspaceFiles.push(file);
}
function recordWorkspaceChange(summary, filePath, kind) {
  if (!summary || !['created', 'modified', 'deleted'].includes(kind)) return;
  if (kind === 'modified' && summary.created?.includes(filePath)) return;
  summary[kind] ||= [];
  if (!summary[kind].includes(filePath)) summary[kind].push(filePath);
}

async function materializeCodexWorkspace(vault, task) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'entail-codex-'));
  try {
    const project = Object.hasOwn(vault.projects || {}, task.projectId) ? vault.projects[task.projectId] : null;
    if (project) await fs.writeFile(path.join(tempDir, 'project.paper-graph.json'), JSON.stringify(project, null, 2));
    for (const file of Object.values(vault.files || {}).filter((item) => item.scope === task.workspaceScope)) {
      const target = path.resolve(tempDir, file.path);
      if (!target.startsWith(`${path.resolve(tempDir)}${path.sep}`)) continue;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, Buffer.from(file.data || '', 'base64'));
    }
    return tempDir;
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function collectCodexWorkspaceChanges(tempDir, baselineFiles = []) {
  const root = path.resolve(tempDir);
  const baselineByPath = new Map(baselineFiles.map((file) => [normalizeWorkspacePath(file.path), file]));
  const finalByPath = new Map();
  const encounteredPaths = new Set();
  const skipped = [];

  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizeWorkspacePath(path.relative(root, absolutePath).split(path.sep).join('/'));
      if (!relativePath || SYNTHETIC_WORKSPACE_PATHS.has(relativePath)) continue;
      encounteredPaths.add(relativePath);
      if (!isValidWorkspacePath(relativePath)) {
        skipped.push({ path: relativePath, reason: 'invalid_path' });
        continue;
      }
      if (entry.isSymbolicLink()) {
        skipped.push({ path: relativePath, reason: 'symbolic_link' });
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        skipped.push({ path: relativePath, reason: 'unsupported_entry' });
        continue;
      }
      const stat = await fs.stat(absolutePath);
      if (stat.size > MAX_WORKSPACE_FILE_BYTES) {
        skipped.push({ path: relativePath, reason: 'file_too_large', size: stat.size });
        continue;
      }
      const buffer = await fs.readFile(absolutePath);
      finalByPath.set(relativePath, {
        path: relativePath,
        name: entry.name.slice(0, 180),
        type: workspaceMimeType(relativePath),
        size: buffer.byteLength,
        data: buffer.toString('base64'),
      });
    }
  }

  await visit(root);
  const upserts = [];
  const created = [];
  const modified = [];
  for (const [filePath, file] of finalByPath) {
    const baseline = baselineByPath.get(filePath);
    if (!baseline) {
      created.push(filePath);
      upserts.push(file);
    } else if (String(baseline.data || '') !== file.data) {
      modified.push(filePath);
      upserts.push(file);
    }
  }
  const deleted = [...baselineByPath.keys()]
    .filter((filePath) => !SYNTHETIC_WORKSPACE_PATHS.has(filePath))
    .filter((filePath) => !finalByPath.has(filePath) && !encounteredPaths.has(filePath));
  upserts.sort((left, right) => left.path.localeCompare(right.path));
  created.sort();
  modified.sort();
  deleted.sort();
  skipped.sort((left, right) => left.path.localeCompare(right.path));
  return { upserts, deletes: deleted, created, modified, deleted, skipped };
}

export async function persistCodexWorkspaceChanges(userStore, session, scope, tempDir, baselineFiles = []) {
  const changes = await collectCodexWorkspaceChanges(tempDir, baselineFiles);
  const baselineByPath = new Map(baselineFiles.map((file) => [normalizeWorkspacePath(file.path), file]));
  const committed = { created: [], modified: [], deleted: [], conflicts: [] };
  const timestamp = new Date().toISOString();
  await userStore.updateVault(session, (vault) => {
    vault.files ||= {};
    for (const file of changes.upserts) {
      const key = workspaceFileKey(scope, file.path);
      const baseline = baselineByPath.get(file.path);
      const current = vault.files[key];
      const currentChanged = baseline
        ? !current || String(current.data || '') !== String(baseline.data || '')
        : current && String(current.data || '') !== file.data;
      if (currentChanged && String(current.data || '') !== file.data) {
        committed.conflicts.push(file.path);
        continue;
      }
      vault.files[key] = { ...file, scope, updatedAt: timestamp };
      (baseline ? committed.modified : committed.created).push(file.path);
    }
    for (const filePath of changes.deletes) {
      const key = workspaceFileKey(scope, filePath);
      const baseline = baselineByPath.get(filePath);
      const current = vault.files[key];
      if (!current) continue;
      if (!baseline || String(current.data || '') !== String(baseline.data || '')) {
        committed.conflicts.push(filePath);
        continue;
      }
      delete vault.files[key];
      committed.deleted.push(filePath);
    }
  });
  return {
    committed: true,
    ...committed,
    skipped: changes.skipped,
  };
}

function normalizeWorkspacePath(value = '') {
  return String(value).replaceAll('\\', '/').replace(/^\/+/, '');
}

function isValidWorkspacePath(filePath) {
  return Boolean(filePath)
    && filePath.length <= 500
    && !filePath.includes('\0')
    && filePath.split('/').every((part) => part && part !== '.' && part !== '..');
}

function workspaceFileKey(scope, filePath) {
  return `${scope}::${filePath}`;
}

function workspaceMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.tsv': 'text/tab-separated-values',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.ts': 'text/typescript',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }[extension] || 'application/octet-stream';
}

async function readPdfText(file, options = {}) {
  const data = new Uint8Array(Buffer.from(file.data || '', 'base64'));
  const document = await getDocument({ data, disableWorker: true, isEvalSupported: false }).promise;
  try {
    const pageCount = document.numPages;
    const maxPages = clampNumber(options.max_pages, 1, 80, 30);
    const maxChars = clampNumber(options.max_chars, 2_000, 120_000, 60_000);
    const requestedPages = Array.isArray(options.pages) ? options.pages : [];
    const pages = requestedPages.length
      ? [...new Set(requestedPages.map(Number).filter((page) => Number.isInteger(page) && page >= 1 && page <= pageCount))].slice(0, 80)
      : Array.from({ length: Math.min(pageCount, maxPages) }, (_, index) => index + 1);
    const output = [];
    let remaining = maxChars;
    let textTruncated = false;
    for (const pageNumber of pages) {
      if (remaining <= 0) { textTruncated = true; break; }
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const fullText = content.items.map((item) => item.str || '').join(' ').replace(/\s+/g, ' ').trim();
      const text = fullText.slice(0, remaining);
      if (text.length < fullText.length) textTruncated = true;
      output.push({ page: pageNumber, text });
      remaining -= text.length;
    }
    return {
      path: file.path,
      pageCount,
      pages: output,
      truncated: textTruncated || output.length < pages.length || (!requestedPages.length && pageCount > maxPages),
    };
  } finally {
    await document.destroy();
  }
}
