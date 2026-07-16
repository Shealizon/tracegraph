import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { buildCodexExecArgs, executeCodexStream, formatCodexFailure, normalizeCodexItemEvent, normalizeCodexModels } from '../server/codexCli.mjs';
import { parseDeviceLoginOutput } from '../server/codexAuth.mjs';
import { applyCodexProgress } from '../server/taskRunner.mjs';

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

  it('extracts the verification URL and one-time code from device login output', () => {
    expect(parseDeviceLoginOutput('Open https://auth.openai.com/codex/device and enter ABCD-EFGH')).toEqual({
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
    });
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
});
