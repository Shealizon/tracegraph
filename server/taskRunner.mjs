import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { randomId } from './security.mjs';
import { httpError } from './userStore.mjs';
import { discoverCodexModels, executeCodexStream } from './codexCli.mjs';
import { persistArtifacts } from './extensionRegistry.mjs';

export class TaskRunner {
  constructor(userStore, extensions = null) {
    this.userStore = userStore;
    this.extensions = extensions;
    this.codexQueue = Promise.resolve();
    this.controllers = new Map();
    this.liveTasks = new Map();
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
      id, type: 'ai', status: 'queued', providerId: input.providerId, model: input.model || '',
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
    const vault = await this.userStore.readVault(session);
    const task = this.liveTasks.get(`${session.userId}:${id}`) || vault.tasks?.[id];
    if (!task) throw httpError(404, '任务不存在');
    return sanitizeTask(task);
  }

  async cancel(session, id) {
    const key = `${session.userId}:${id}`;
    const live = this.liveTasks.get(key);
    if (live) { live.status = 'cancelled'; live.updatedAt = new Date().toISOString(); }
    this.controllers.get(key)?.abort();
    await this.patch(session, id, { status: 'cancelled', updatedAt: new Date().toISOString() });
    return this.get(session, id);
  }

  async runProvider(session, task) {
    const controller = new AbortController();
    this.controllers.set(`${session.userId}:${task.id}`, controller);
    try {
      await this.patch(session, task.id, { status: 'running', updatedAt: new Date().toISOString() });
      const vault = await this.userStore.readVault(session);
      const provider = Object.hasOwn(vault.providers || {}, task.providerId) ? vault.providers[task.providerId] : null;
      if (!provider) throw new Error('云端模型服务不存在，请重新保存服务商配置');
      const output = await callProvider(provider, task, controller.signal, vault, {
        extensions: this.extensions,
        userStore: this.userStore,
        session,
        fileAccessMode: task.input.fileAccessMode,
      });
      await this.patch(session, task.id, { status: 'completed', output, updatedAt: new Date().toISOString() });
    } catch (error) {
      const status = controller.signal.aborted ? 'cancelled' : 'failed';
      await this.patch(session, task.id, { status, error: error?.message || String(error), updatedAt: new Date().toISOString() });
    } finally {
      this.controllers.delete(`${session.userId}:${task.id}`);
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
      const workspaceFiles = Object.values(vault.files || {}).filter((item) => item.scope === task.workspaceScope);
      const prompt = [
        '当前目录是该用户此次任务的临时可写工作区快照；项目数据位于 project.paper-graph.json，附件保持原工作区相对路径。读写操作仅限这个临时工作区。',
        task.input.fileAccessMode === 'allow'
          ? '当前对话允许扩展工具写回文件。'
          : '当前对话未授予后台任务交互式写入权限；不要尝试用扩展工具生成或修改用户文件。',
        this.extensions?.skillPrompt(),
        task.input.systemPrompt,
        ...task.input.history.map((m) => `${m.role}: ${m.content}`),
        `user: ${task.input.userText}`,
      ].filter(Boolean).join('\n\n');
      const output = await executeCodexStream({
        prompt, cwd: tempDir, model: task.model, signal: controller.signal,
        dynamicTools: this.extensions?.dynamicTools({ includeWrites: task.input.fileAccessMode === 'allow' }) || [],
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
        onEvent: (event) => { applyCodexProgress(task, event); scheduleProgress(); },
      });
      if (progressTimer) await flushProgress();
      else await progressWrites;
      task.output = output;
      syncFinalTextBlock(task);
      task.status = 'completed';
      await this.patch(session, task.id, { status: 'completed', output: task.output, blocks: task.blocks, updatedAt: new Date().toISOString() });
    } catch (error) {
      clearTimeout(progressTimer);
      await progressWrites.catch(() => {});
      const status = controller.signal.aborted || error?.name === 'AbortError' ? 'cancelled' : 'failed';
      task.status = status;
      task.error = error?.message || String(error);
      await this.patch(session, task.id, { status, output: task.output, blocks: task.blocks, error: error?.message || String(error), updatedAt: new Date().toISOString() });
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

async function callProvider(provider, task, signal, vault, extensionContext = {}) {
  const protocol = provider.protocol || 'openai-chat';
  const base = String(provider.baseUrl || '').replace(/\/+$/, '');
  const messages = [
    ...(extensionContext.extensions?.skillPrompt() ? [{ role: 'system', content: extensionContext.extensions.skillPrompt() }] : []),
    ...(task.input.systemPrompt ? [{ role: 'system', content: task.input.systemPrompt }] : []),
    ...task.input.history.filter((m) => ['user', 'assistant'].includes(m.role)).map((m) => ({ role: m.role, content: String(m.content || '') })),
    { role: 'user', content: task.input.userText },
  ];
  const serverTools = createServerTools(vault, task.projectId, task.workspaceScope, {
    ...extensionContext,
    signal,
    fileAccessMode: task.input.fileAccessMode,
  });
  let response;
  if (protocol === 'anthropic-messages') {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const anthropicMessages = messages.filter((m) => m.role !== 'system');
    const anthropicTools = serverTools.definitions.map((tool) => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters }));
    for (let round = 0; round < 8; round += 1) {
      response = await fetch(`${base}/messages`, { method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: task.model || provider.model, max_tokens: 8192, system, messages: anthropicMessages, tools: anthropicTools }) });
      const data = await jsonResponse(response);
      const blocks = data.content || [];
      const calls = blocks.filter((part) => part.type === 'tool_use');
      if (!calls.length) return blocks.filter((part) => part.type === 'text').map((part) => part.text).join('');
      anthropicMessages.push({ role: 'assistant', content: blocks });
      const results = [];
      for (const call of calls) results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(await serverTools.execute(call.name, call.input || {})) });
      anthropicMessages.push({ role: 'user', content: results });
    }
    throw new Error('模型工具调用轮次过多');
  }
  if (protocol === 'gemini') {
    const model = encodeURIComponent(String(task.model || provider.model).replace(/^models\//, ''));
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const functionDeclarations = serverTools.definitions.map((tool) => ({ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters }));
    for (let round = 0; round < 8; round += 1) {
      response = await fetch(`${base}/models/${model}:generateContent`, { method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-goog-api-key': provider.apiKey }, body: JSON.stringify({ systemInstruction: system ? { parts: [{ text: system }] } : undefined, contents, tools: [{ functionDeclarations }] }) });
      const data = await jsonResponse(response);
      const parts = data.candidates?.[0]?.content?.parts || [];
      const calls = parts.filter((part) => part.functionCall);
      if (!calls.length) return parts.map((part) => part.text || '').join('');
      contents.push({ role: 'model', parts });
      const results = [];
      for (const part of calls) results.push({ functionResponse: { name: part.functionCall.name, response: await serverTools.execute(part.functionCall.name, part.functionCall.args || {}) } });
      contents.push({ role: 'user', parts: results });
    }
    throw new Error('模型工具调用轮次过多');
  }
  for (let round = 0; round < 8; round += 1) {
    response = await fetch(`${base}/chat/completions`, { method: 'POST', signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` }, body: JSON.stringify({ model: task.model || provider.model, messages, tools: serverTools.definitions, tool_choice: 'auto' }) });
    const data = await jsonResponse(response);
    const message = data.choices?.[0]?.message || {};
    const calls = message.tool_calls || [];
    if (!calls.length) return message.content || '';
    messages.push({ role: 'assistant', content: message.content || null, tool_calls: calls });
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* malformed arguments become empty */ }
      const content = await serverTools.execute(call.function?.name, args);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(content) });
    }
  }
  throw new Error('模型工具调用轮次过多');
}

async function jsonResponse(response) {
  const text = await response.text();
  if (!response.ok) throw new Error(`模型请求失败（${response.status}）：${text.slice(0, 500)}`);
  try { return JSON.parse(text); } catch { throw new Error('模型返回了无效 JSON'); }
}

function sanitizeTask(task) {
  const { input, ...safe } = task;
  return { ...safe, inputPreview: input?.userText?.slice(0, 160) || '' };
}

export function createServerTools(vault, projectId, workspaceScope, extensionContext = {}) {
  const allowExtensionWrites = !extensionContext.fileAccessMode || extensionContext.fileAccessMode === 'allow';
  const project = Object.hasOwn(vault.projects || {}, projectId) ? vault.projects[projectId] : null;
  const nodes = (project?.documents || []).flatMap((document) => (document.graph?.nodes || []).map((node) => ({ ...node, documentId: document.id, documentName: document.name })));
  const workspaceFiles = Object.values(vault.files || {}).filter((file) => file.scope === workspaceScope);
  const definitions = [
    toolDefinition('get_project_summary', '读取当前项目、文档和图谱规模摘要。', { type: 'object', properties: {}, additionalProperties: false }),
    toolDefinition('search_graph', '在当前项目的节点标题、正文和 ID 中搜索。', { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 30 } }, required: ['query'], additionalProperties: false }),
    toolDefinition('get_graph_node', '按节点 ID 读取完整节点内容和引用。', { type: 'object', properties: { node_id: { type: 'string' } }, required: ['node_id'], additionalProperties: false }),
    toolDefinition('list_workspace', '列出当前对话已上传到云端工作区的文件。', { type: 'object', properties: {}, additionalProperties: false }),
    toolDefinition('read_file', '读取云端工作区中的 UTF-8 文本文件。', { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }),
    toolDefinition('read_pdf', '在服务端解析云端工作区 PDF 的文字层，可指定页码。', { type: 'object', properties: { path: { type: 'string' }, pages: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 20 } }, required: ['path'], additionalProperties: false }),
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
    if (name === 'get_graph_node') {
      const node = nodes.find((item) => item.id === args.node_id);
      return node || { error: 'node_not_found', node_id: args.node_id };
    }
    if (name === 'list_workspace') return { files: workspaceFiles.map(({ data, ...file }) => file) };
    if (name === 'read_file') {
      const file = workspaceFiles.find((item) => item.path === args.path);
      if (!file) return { error: 'file_not_found', path: args.path };
      if (!isTextFile(file)) return { error: 'binary_file', path: file.path, type: file.type, size: file.size };
      const content = Buffer.from(file.data || '', 'base64').toString('utf8');
      return { path: file.path, type: file.type, content: content.slice(0, 250_000), truncated: content.length > 250_000 };
    }
    if (name === 'read_pdf') {
      const file = workspaceFiles.find((item) => item.path === args.path);
      if (!file) return { error: 'file_not_found', path: args.path };
      if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.path)) return { error: 'not_pdf', path: file.path, type: file.type };
      return readPdfText(file, args.pages);
    }
    if (extensionContext.extensions?.findTool(name)) {
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
      for (const artifact of execution.artifacts) workspaceFiles.push({ ...artifact, scope: workspaceScope });
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

async function readPdfText(file, requestedPages) {
  const data = new Uint8Array(Buffer.from(file.data || '', 'base64'));
  const document = await getDocument({ data, disableWorker: true, isEvalSupported: false }).promise;
  const pageCount = document.numPages;
  const pages = Array.isArray(requestedPages) && requestedPages.length
    ? [...new Set(requestedPages.map(Number).filter((page) => Number.isInteger(page) && page >= 1 && page <= document.numPages))].slice(0, 20)
    : Array.from({ length: Math.min(document.numPages, 20) }, (_, index) => index + 1);
  const output = [];
  for (const pageNumber of pages) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    output.push({ page: pageNumber, text: content.items.map((item) => item.str || '').join(' ').replace(/\s+/g, ' ').trim() });
  }
  await document.destroy();
  return { path: file.path, pageCount, pages: output, truncated: !requestedPages?.length && pageCount > 20 };
}
