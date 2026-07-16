import { afterEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCodexExecArgs, executeCodexStream, formatCodexFailure, normalizeCodexItemEvent, normalizeCodexModels } from '../server/codexCli.mjs';
import { CodexAuthManager } from '../server/codexAuth.mjs';
import { applyCodexProgress, callProvider, collectCodexWorkspaceChanges, createServerTools, persistCodexWorkspaceChanges, TaskRunner } from '../server/taskRunner.mjs';

afterEach(() => vi.unstubAllGlobals());

describe('server Codex adapter', () => {
  it('normalizes the app-server model catalog and hides hidden entries', () => {
    expect(normalizeCodexModels([
      {
        id: 'catalog-id', model: 'gpt-current', displayName: 'GPT Current', description: 'Default model',
        hidden: false, isDefault: true, defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }],
      },
      { id: 'hidden', model: 'hidden', hidden: true },
    ])).toEqual([{
      id: 'gpt-current', displayName: 'GPT Current', description: 'Default model', isDefault: true,
      defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium'],
    }]);
  });

  it('passes an explicit selected model and reads the prompt from stdin', () => {
    const args = buildCodexExecArgs({ model: 'gpt-current', outputPath: '/tmp/final.md' });
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-current');
    expect(args.at(-1)).toBe('-');
    expect(args).toContain('--json');
    expect(args).toContain('workspace-write');
  });

  it('maps the legacy codex placeholder to the CLI default model', () => {
    const args = buildCodexExecArgs({ model: 'codex', outputPath: '/tmp/final.md' });
    expect(args).not.toContain('--model');
  });

  it('turns a region failure into an actionable server error', () => {
    expect(formatCodexFailure('unsupported_country_region_territory')).toContain('HTTPS_PROXY');
  });

  it('uses the structured app-server device login flow', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: vi.fn() });
    const requests = [];
    stdin.on('data', (chunk) => {
      for (const line of String(chunk).trim().split('\n')) {
        const request = JSON.parse(line);
        requests.push(request);
        if (request.id === 0) stdout.write(`${JSON.stringify({ id: 0, result: {} })}\n`);
        if (request.id === 1) stdout.write(`${JSON.stringify({
          id: 1,
          result: {
            type: 'chatgptDeviceCode',
            loginId: 'login-1',
            verificationUrl: 'https://auth.openai.com/codex/device',
            userCode: 'ABCD-EFGH',
          },
        })}\n`);
      }
    });
    const spawnImpl = vi.fn(() => child);
    const manager = new CodexAuthManager({ spawnImpl });
    const initial = await manager.startDeviceLogin();
    const waiting = manager.getLogin(initial.id);

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl.mock.calls[0][1].at(-1)).toBe('app-server');
    expect(spawnImpl.mock.calls[0][2].stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(requests.find((request) => request.id === 0)?.params.capabilities).toEqual({ experimentalApi: true });
    expect(requests.find((request) => request.id === 1)).toMatchObject({
      method: 'account/login/start',
      params: { type: 'chatgptDeviceCode' },
    });
    expect(waiting).toMatchObject({
      status: 'waiting',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
    });

    stdout.write(`${JSON.stringify({
      method: 'account/login/completed',
      params: { loginId: 'login-1', success: true, error: null },
    })}\n`);
    expect(manager.getLogin(initial.id).status).toBe('completed');
  });

  it('streams app-server answer deltas, reasoning summaries, and tool lifecycle events', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill() {} });
    let threadStart;
    stdin.on('data', (chunk) => {
      for (const line of String(chunk).trim().split('\n')) {
        const request = JSON.parse(line);
        if (request.id === 0) stdout.write(`${JSON.stringify({ id: 0, result: {} })}\n`);
        if (request.id === 1) {
          threadStart = request;
          stdout.write(`${JSON.stringify({ id: 1, result: { thread: { id: 'thr-1' } } })}\n`);
        }
        if (request.id === 2) {
          const messages = [
            { method: 'item/started', params: { item: { id: 'note1', type: 'agentMessage', phase: 'commentary', text: '' }, startedAtMs: 0 } },
            { method: 'item/agentMessage/delta', params: { itemId: 'note1', delta: '准备调用工具。' } },
            { method: 'item/reasoning/summaryTextDelta', params: { itemId: 'r1', delta: '先检查图谱。' } },
            { method: 'item/started', params: { item: { id: 'c1', type: 'commandExecution', command: 'ls', cwd: '/tmp', status: 'inProgress', commandActions: [] }, startedAtMs: 1 } },
            { method: 'item/completed', params: { item: { id: 'c1', type: 'commandExecution', command: 'ls', cwd: '/tmp', status: 'completed', commandActions: [], aggregatedOutput: 'project.json', exitCode: 0, durationMs: 5 }, completedAtMs: 2 } },
            { method: 'item/started', params: { item: { id: 'a1', type: 'agentMessage', phase: 'final_answer', text: '' }, startedAtMs: 3 } },
            { method: 'item/agentMessage/delta', params: { itemId: 'a1', delta: '第一段' } },
            { method: 'item/agentMessage/delta', params: { itemId: 'a1', delta: '第二段' } },
            { method: 'turn/completed', params: { threadId: 'thr-1', turn: { id: 'turn-1', status: 'completed' } } },
          ];
          for (const message of messages) stdout.write(`${JSON.stringify(message)}\n`);
        }
      }
    });
    const events = [];
    const result = await executeCodexStream({ prompt: 'test', cwd: '/tmp', spawnImpl: () => child, onEvent: (event) => events.push(event) });
    expect(result).toBe('第一段第二段');
    expect(threadStart?.params).toMatchObject({ sandbox: 'workspace-write', approvalPolicy: 'never' });
    expect(events.map((event) => event.type)).toEqual(['reasoning_delta', 'reasoning_delta', 'tool', 'tool', 'text_delta', 'text_delta']);
    expect(events.find((event) => event.type === 'tool' && event.status === 'done')?.result).toMatchObject({ output: 'project.json', exitCode: 0 });
  });

  it('registers and executes app-server dynamic tools', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill() {} });
    let initialize;
    let threadStart;
    let toolResponse;
    stdin.on('data', (chunk) => {
      for (const line of String(chunk).trim().split('\n')) {
        const request = JSON.parse(line);
        if (request.id === 0) {
          initialize = request;
          stdout.write(`${JSON.stringify({ id: 0, result: {} })}\n`);
        }
        if (request.id === 1) {
          threadStart = request;
          stdout.write(`${JSON.stringify({ id: 1, result: { thread: { id: 'thr-dynamic' } } })}\n`);
        }
        if (request.id === 2) {
          stdout.write(`${JSON.stringify({
            id: 40,
            method: 'item/tool/call',
            params: {
              threadId: 'thr-dynamic',
              turnId: 'turn-dynamic',
              callId: 'call-pdf',
              tool: 'pdf_info',
              arguments: { file: 'paper.pdf' },
            },
          })}\n`);
        }
        if (request.id === 40) {
          toolResponse = request;
          stdout.write(`${JSON.stringify({ method: 'item/started', params: { item: { id: 'a2', type: 'agentMessage', phase: 'final_answer', text: '' } } })}\n`);
          stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: { itemId: 'a2', delta: 'PDF 共 3 页。' } })}\n`);
          stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn-dynamic', status: 'completed' } } })}\n`);
        }
      }
    });
    const onDynamicToolCall = vi.fn(async () => ({ pages: 3 }));
    const events = [];
    const result = await executeCodexStream({
      prompt: 'inspect pdf',
      cwd: '/tmp',
      spawnImpl: () => child,
      dynamicTools: [{
        name: 'pdf_info',
        description: 'PDF info',
        inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] },
      }],
      onDynamicToolCall,
      onEvent: (event) => events.push(event),
    });
    expect(result).toBe('PDF 共 3 页。');
    expect(initialize.params.capabilities).toEqual({ experimentalApi: true });
    expect(threadStart.params.dynamicTools[0].name).toBe('pdf_info');
    expect(onDynamicToolCall).toHaveBeenCalledWith('pdf_info', { file: 'paper.pdf' }, expect.objectContaining({ callId: 'call-pdf' }));
    expect(toolResponse.result).toEqual({
      success: true,
      contentItems: [{ type: 'inputText', text: '{"pages":3}' }],
    });
    expect(events.filter((event) => event.name === 'pdf_info').map((event) => event.status)).toEqual(['running', 'done']);
  });

  it('normalizes web and MCP items for the visible tool timeline', () => {
    expect(normalizeCodexItemEvent({ id: 'w1', type: 'webSearch', query: 'paper graph' }, 'running')).toMatchObject({ name: 'web_search', status: 'running' });
    expect(normalizeCodexItemEvent({ id: 'm1', type: 'mcpToolCall', server: 'docs', tool: 'search', arguments: { q: 'x' }, status: 'completed', result: { ok: true } }, 'done'))
      .toMatchObject({ name: 'search', status: 'done', args: { q: 'x' }, result: { ok: true } });
  });

  it('builds ordered answer, reasoning, and tool blocks from streamed events', () => {
    const task = { output: '', blocks: [] };
    applyCodexProgress(task, { type: 'reasoning_delta', delta: '检查数据' });
    applyCodexProgress(task, { type: 'tool', id: 't1', name: 'shell_command', status: 'running', args: { command: 'ls' } });
    applyCodexProgress(task, { type: 'tool', id: 't1', name: 'shell_command', status: 'done', result: { output: 'a.txt' } });
    applyCodexProgress(task, { type: 'text_delta', delta: '结论' });
    expect(task.output).toBe('结论');
    expect(task.blocks).toEqual([
      { type: 'reasoning', content: '检查数据' },
      { type: 'tool', key: 't1', name: 'shell_command', args: { command: 'ls' }, status: 'done', result: { output: 'a.txt' } },
      { type: 'text', content: '结论' },
    ]);
  });

  it('collects created, modified, and deleted files from the Codex workspace snapshot', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-workspace-test-'));
    const encoded = (value) => Buffer.from(value).toString('base64');
    try {
      await fs.mkdir(path.join(tempDir, 'notes'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'notes', 'changed.md'), 'new value');
      await fs.writeFile(path.join(tempDir, 'created.txt'), 'created');
      await fs.writeFile(path.join(tempDir, 'unchanged.txt'), 'same');
      await fs.writeFile(path.join(tempDir, 'project.paper-graph.json'), '{"synthetic":true}');
      const changes = await collectCodexWorkspaceChanges(tempDir, [
        { path: 'notes/changed.md', data: encoded('old value') },
        { path: 'unchanged.txt', data: encoded('same') },
        { path: 'deleted.txt', data: encoded('remove me') },
      ]);
      expect(changes.created).toEqual(['created.txt']);
      expect(changes.modified).toEqual(['notes/changed.md']);
      expect(changes.deleted).toEqual(['deleted.txt']);
      expect(changes.upserts.map((file) => file.path)).toEqual(['created.txt', 'notes/changed.md']);
      expect(changes.upserts.map((file) => file.path)).not.toContain('project.paper-graph.json');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('persists Codex workspace changes while preserving concurrent user edits', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-workspace-persist-test-'));
    const encoded = (value) => Buffer.from(value).toString('base64');
    const scope = 'project--conversation';
    const baseline = [
      { scope, path: 'changed.md', data: encoded('old') },
      { scope, path: 'conflict.md', data: encoded('old conflict') },
      { scope, path: 'deleted.md', data: encoded('delete') },
    ];
    const vault = {
      files: {
        [`${scope}::changed.md`]: { ...baseline[0] },
        [`${scope}::conflict.md`]: { ...baseline[1], data: encoded('new user version') },
        [`${scope}::deleted.md`]: { ...baseline[2] },
      },
    };
    const userStore = {
      updateVault: vi.fn(async (_session, update) => {
        await update(vault);
        return vault;
      }),
    };
    try {
      await fs.writeFile(path.join(tempDir, 'changed.md'), 'AI change');
      await fs.writeFile(path.join(tempDir, 'conflict.md'), 'AI conflict');
      await fs.writeFile(path.join(tempDir, 'created.md'), 'AI created');
      const summary = await persistCodexWorkspaceChanges(userStore, {}, scope, tempDir, baseline);
      expect(summary).toMatchObject({
        committed: true,
        created: ['created.md'],
        modified: ['changed.md'],
        deleted: ['deleted.md'],
        conflicts: ['conflict.md'],
      });
      expect(Buffer.from(vault.files[`${scope}::changed.md`].data, 'base64').toString()).toBe('AI change');
      expect(Buffer.from(vault.files[`${scope}::created.md`].data, 'base64').toString()).toBe('AI created');
      expect(Buffer.from(vault.files[`${scope}::conflict.md`].data, 'base64').toString()).toBe('new user version');
      expect(vault.files[`${scope}::deleted.md`]).toBeUndefined();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('exposes a persistent text writer to allowed server providers only', async () => {
    const scope = 'project--conversation';
    const vault = { projects: {}, files: {} };
    const workspaceChanges = { committed: true, created: [], modified: [], deleted: [], skipped: [], conflicts: [] };
    const userStore = {
      updateVault: vi.fn(async (_session, update) => {
        await update(vault);
        return vault;
      }),
    };
    const allowed = createServerTools(vault, '', scope, {
      fileAccessMode: 'allow',
      userStore,
      session: { userId: 'user-1' },
      workspaceChanges,
    });
    expect(allowed.definitions.map((item) => item.function.name)).toContain('write_file');
    await expect(allowed.execute('write_file', {
      path: 'notes/result.md',
      content: '# Result\n\nSaved.',
    })).resolves.toMatchObject({
      path: 'notes/result.md',
      written: true,
      type: 'text/markdown',
    });
    expect(Buffer.from(vault.files[`${scope}::notes/result.md`].data, 'base64').toString()).toBe('# Result\n\nSaved.');
    await expect(allowed.execute('read_file', { path: 'notes/result.md' })).resolves.toMatchObject({
      path: 'notes/result.md',
      content: '# Result\n\nSaved.',
    });
    expect(workspaceChanges.created).toEqual(['notes/result.md']);

    await expect(allowed.execute('write_file', { path: '../outside.md', content: 'blocked' })).resolves.toMatchObject({
      written: false,
      reason: '无效的工作区路径',
    });
    const readOnly = createServerTools(vault, '', scope, {
      fileAccessMode: 'read-only',
      userStore,
      session: { userId: 'user-1' },
    });
    expect(readOnly.definitions.map((item) => item.function.name)).not.toContain('write_file');
  });

  it('streams server-provider reasoning, text, and tool lifecycle across tool rounds', async () => {
    const sse = (...events) => new Response(events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
    const responses = [
      sse(
        { choices: [{ delta: { reasoning_content: '先创建文件。' } }] },
        { choices: [{ delta: { content: '正在保存。' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-write', function: { name: 'write_file', arguments: '{"path":"notes/cloud.md",' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"# Cloud\\n\\nSaved."}' } }] } }] },
        '[DONE]',
      ),
      sse(
        { choices: [{ delta: { content: '文件已经保存。' } }] },
        '[DONE]',
      ),
    ];
    const fetchMock = vi.fn(async () => responses.shift());
    vi.stubGlobal('fetch', fetchMock);
    const scope = 'project--conversation';
    const vault = { projects: {}, files: {} };
    const workspaceChanges = { committed: true, created: [], modified: [], deleted: [], skipped: [], conflicts: [] };
    const events = [];
    const userStore = {
      updateVault: vi.fn(async (_session, update) => {
        await update(vault);
        return vault;
      }),
    };
    const output = await callProvider({
      protocol: 'openai-chat',
      baseUrl: 'https://provider.test/v1',
      apiKey: 'secret',
      model: 'cloud-model',
    }, {
      model: 'cloud-model',
      projectId: '',
      workspaceScope: scope,
      input: {
        systemPrompt: '',
        history: [],
        userText: '保存 Markdown',
        fileAccessMode: 'allow',
      },
    }, new AbortController().signal, vault, {
      userStore,
      session: { userId: 'user-1' },
      fileAccessMode: 'allow',
      workspaceChanges,
      onEvent: (event) => events.push(event),
    });
    expect(output).toBe('正在保存。文件已经保存。');
    expect(events).toEqual(expect.arrayContaining([
      { type: 'reasoning_delta', delta: '先创建文件。' },
      { type: 'text_delta', delta: '正在保存。' },
      expect.objectContaining({ type: 'tool', id: 'call-write', name: 'write_file', status: 'running' }),
      expect.objectContaining({ type: 'tool', id: 'call-write', name: 'write_file', status: 'done', result: expect.objectContaining({ written: true }) }),
      { type: 'text_delta', delta: '文件已经保存。' },
    ]));
    expect(Buffer.from(vault.files[`${scope}::notes/cloud.md`].data, 'base64').toString()).toBe('# Cloud\n\nSaved.');
    expect(workspaceChanges.created).toEqual(['notes/cloud.md']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ stream: true, model: 'cloud-model' });
    const secondRequest = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondRequest.messages.map((message) => message.role).slice(-2)).toEqual(['assistant', 'tool']);
  });

  it('gives cloud providers file search, web research, and batch graph tools', async () => {
    const scope = 'project-1--conversation-1';
    const encoded = (value) => Buffer.from(value).toString('base64');
    const vault = {
      projects: {
        'project-1': {
          id: 'project-1',
          name: 'Cloud graph',
          config: { enabledDocumentIds: ['doc-1'], disabledNodeIds: [], disabledRelationKeys: [] },
          documents: [{
            id: 'doc-1',
            name: 'Document',
            graph: {
              format: 'relation-graph@1',
              meta: { title: 'Cloud graph' },
              types: [{ id: 'idea', label: '概念' }],
              nodes: [
                { id: 'a', type: 'idea', title: '基础', sections: [{ kind: 'statement', body: 'Base statement' }], anchors: [{ id: 'eq:base' }] },
                { id: 'b', type: 'idea', title: '应用', sections: [{ kind: 'statement', body: 'Uses base' }], anchors: [{ id: 'b' }], refs: [{ id: 'r1', target: 'eq:base' }] },
              ],
            },
          }],
        },
      },
      files: {
        [`${scope}::notes/research.md`]: {
          scope,
          path: 'notes/research.md',
          name: 'research.md',
          type: 'text/markdown',
          size: 30,
          data: encoded('Hardy uncertainty principle notes'),
        },
      },
    };
    const tools = createServerTools(vault, 'project-1', scope, { fileAccessMode: 'read-only' });
    const names = tools.definitions.map((item) => item.function.name);
    expect(names).toEqual(expect.arrayContaining([
      'search_files',
      'web_search',
      'open_url',
      'resolve_doi',
      'search_graph_nodes',
      'get_graph_nodes',
      'get_graph_neighbors_batch',
    ]));
    await expect(tools.execute('search_files', { query: 'uncertainty' })).resolves.toMatchObject({
      results: [expect.objectContaining({ path: 'notes/research.md' })],
    });
    await expect(tools.execute('get_graph_nodes', { node_ids: ['a', 'b'], detail: 'content' })).resolves.toMatchObject({
      nodes: [expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' })],
      missing: [],
    });
    await expect(tools.execute('get_graph_neighbors_batch', { node_ids: ['b'], direction: 'references' })).resolves.toMatchObject({
      nodes: [{ node: expect.objectContaining({ id: 'b' }), references: [expect.objectContaining({ id: 'a' })] }],
    });
  });

  it('streams cloud compaction without exposing task tools', async () => {
    const fetchMock = vi.fn(async () => new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { content: '<summary>压缩完成</summary>' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);
    const output = await callProvider({
      protocol: 'openai-chat',
      baseUrl: 'https://provider.test/v1',
      apiKey: 'secret',
      model: 'cloud-model',
    }, {
      kind: 'compaction',
      model: 'cloud-model',
      projectId: '',
      workspaceScope: 'scope',
      input: {
        systemPrompt: '只压缩上下文',
        history: [],
        userText: '长对话',
        fileAccessMode: 'read-only',
      },
    }, new AbortController().signal, { projects: {}, files: {} });
    expect(output).toBe('<summary>压缩完成</summary>');
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.stream).toBe(true);
    expect(request.tools).toBeUndefined();
  });

  it('serves live partial provider output before the cloud task completes', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '第一段' } }] })}\n\n`));
        await gate;
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '第二段' } }] })}\n\n`));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })));
    const session = { userId: 'user-1' };
    const task = {
      id: 'task-live',
      type: 'ai',
      kind: 'chat',
      status: 'queued',
      providerId: 'provider-1',
      model: 'cloud-model',
      projectId: '',
      conversationId: 'conversation-1',
      workspaceScope: 'scope',
      input: { history: [], userText: '测试', systemPrompt: '', fileAccessMode: 'read-only' },
      output: '',
      blocks: [],
      error: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const vault = {
      providers: {
        'provider-1': {
          protocol: 'openai-chat',
          baseUrl: 'https://provider.test/v1',
          apiKey: 'secret',
          model: 'cloud-model',
        },
      },
      projects: {},
      files: {},
      tasks: { [task.id]: task },
    };
    const userStore = {
      readVault: vi.fn(async () => vault),
      updateVault: vi.fn(async (_session, update) => {
        await update(vault);
        return vault;
      }),
    };
    const runner = new TaskRunner(userStore);
    const running = runner.runProvider(session, task);
    const pushed = [];
    const unsubscribe = await runner.subscribe(session, task.id, (snapshot) => pushed.push(snapshot));
    await vi.waitFor(async () => {
      const progress = await runner.get(session, task.id);
      expect(progress.status).toBe('running');
      expect(progress.output).toBe('第一段');
      expect(progress.blocks).toEqual([{ type: 'text', content: '第一段' }]);
    });
    await vi.waitFor(() => {
      expect(pushed.some((snapshot) => snapshot.status === 'running' && snapshot.output === '第一段')).toBe(true);
    });
    release();
    await running;
    unsubscribe();
    const completed = await runner.get(session, task.id);
    expect(completed).toMatchObject({ status: 'completed', output: '第一段第二段', streamStatus: 'completed' });
    expect(pushed.at(-1)).toMatchObject({ status: 'completed', output: '第一段第二段' });
  });
});
