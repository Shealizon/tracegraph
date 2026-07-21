import { describe, expect, it } from 'vitest';
import {
  APPLICATION_DATA_EXPORT_FORMAT,
  buildApplicationDataExport,
  buildConversationExport,
  buildProjectDataExport,
  CONVERSATION_EXPORT_FORMAT,
  PROJECT_DATA_EXPORT_FORMAT,
  snapshotStorage,
} from '../src/debug/exportData.js';
import {
  clearDebugRecords,
  createDebugSnapshot,
  debugCheckpoint,
  registerDebugModules,
  setDebugContextProvider,
} from '../src/debug/diagnostics.js';

function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

describe('complete data exports', () => {
  it('keeps the complete raw conversation including reasoning, tools and attachments', () => {
    const conversation = {
      id: 'chat-1',
      title: '调试会话',
      messages: [
        { role: 'user', content: '问题', contextAttachments: [{ kind: 'graph-node', nodeId: 'n1' }] },
        {
          role: 'assistant',
          content: '回答',
          blocks: [
            { type: 'reasoning', content: '内部推理' },
            { type: 'tool', key: 'call-1', name: 'get_graph_node', args: { id: 'n1' }, result: { ok: true } },
            { type: 'text', content: '回答' },
          ],
          sources: [{ citation: '[1]', url: 'https://example.test' }],
        },
      ],
      attachments: [{ path: 'uploads/a.pdf', size: 20 }],
    };

    const payload = buildConversationExport(conversation, {
      projectId: 'p1',
      projectName: '项目',
      exportedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(payload.format).toBe(CONVERSATION_EXPORT_FORMAT);
    expect(payload.conversation).toEqual(conversation);
    expect(payload.conversation).not.toBe(conversation);
    expect(payload.conversation.messages[1].blocks[1].result).toEqual({ ok: true });
  });

  it('builds a project bundle with project state, conversations, local storage and scoped files', async () => {
    const conversations = { version: 1, conversations: [{ id: 'c1', messages: [{ role: 'user', content: 'all' }] }] };
    const storage = memoryStorage({
      'tracegraph-ai-conversations:project:1': JSON.stringify(conversations),
      'hg-theme-mode': 'dark',
    });
    let requestedPrefix = '';
    const workspaceExporter = async ({ scopePrefix }) => {
      requestedPrefix = scopePrefix;
      return [{ scope: `${scopePrefix}c1`, files: [{ path: 'notes/a.md', encoding: 'base64', content: 'YQ==' }] }];
    };

    const payload = await buildProjectDataExport({ id: 'project:1', name: 'P', documents: [] }, {
      storage,
      workspaceExporter,
      exportedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(payload.format).toBe(PROJECT_DATA_EXPORT_FORMAT);
    expect(requestedPrefix).toBe('project-1--');
    expect(payload.ai.conversations).toEqual(conversations);
    expect(payload.ai.workspaces[0].files[0].content).toBe('YQ==');
    expect(payload.browserLocalStorage['hg-theme-mode']).toBe('dark');
  });

  it('builds a global bundle for every project and every workspace', async () => {
    const storage = memoryStorage({
      'tracegraph-ai-conversations:p1': JSON.stringify({ version: 1, conversations: [{ id: 'c1' }] }),
      'tracegraph-ai-conversations:p2': JSON.stringify({ version: 1, conversations: [{ id: 'c2' }] }),
    });
    const projects = [{ id: 'p1' }, { id: 'p2' }];
    const payload = await buildApplicationDataExport({}, {
      storage,
      projectLoader: async () => projects,
      workspaceExporter: async () => [{ scope: 'orphan-workspace', files: [] }],
    });

    expect(payload.format).toBe(APPLICATION_DATA_EXPORT_FORMAT);
    expect(payload.projects).toEqual(projects);
    expect(Object.keys(payload.ai.conversationsByProject)).toEqual(['p1', 'p2']);
    expect(payload.ai.workspaces[0].scope).toBe('orphan-workspace');
    expect(snapshotStorage(storage)).toHaveProperty('tracegraph-ai-conversations:p1');
  });
});

describe('normalized diagnostics', () => {
  it('arms module breakpoints and exports normalized, redacted records', () => {
    clearDebugRecords();
    registerDebugModules(['../ai/modelClient.js', '../view/forceGraph.js']);
    setDebugContextProvider(() => ({ projectId: 'p1', apiKey: 'secret-value' }));
    debugCheckpoint('../ai/modelClient.js', 'request-start', {
      model: 'test-model',
      authorization: 'Bearer secret',
    }, { level: 'info' });

    const snapshot = createDebugSnapshot({ reason: 'test' });

    expect(snapshot.format).toBe('tracegraph-debug-log@1');
    expect(snapshot.context).toEqual({ projectId: 'p1', apiKey: '[REDACTED]' });
    expect(snapshot.records.at(-1)).toMatchObject({
      level: 'info',
      module: 'src/ai/modelClient.js',
      event: 'request-start',
      data: { model: 'test-model', authorization: '[REDACTED]' },
    });
    expect(snapshot.moduleBreakpoints.find((item) => item.module === 'src/view/forceGraph.js')).toMatchObject({ status: 'armed' });
  });
});
