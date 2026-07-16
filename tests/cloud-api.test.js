import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamTask } from '../src/cloud/api.js';

afterEach(() => vi.unstubAllGlobals());

describe('cloud task event stream', () => {
  it('delivers incremental task snapshots and returns the terminal task', async () => {
    const snapshots = [
      { id: 'task-1', status: 'running', output: '第一段', progressVersion: 1 },
      { id: 'task-1', status: 'completed', output: '第一段第二段', progressVersion: 2 },
    ];
    const body = snapshots.map((task) => `data: ${JSON.stringify({ task })}\n\n`).join('');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })));
    const received = [];
    const result = await streamTask('task-1', { onTask: (task) => received.push(task) });
    expect(received).toEqual(snapshots);
    expect(result).toEqual(snapshots[1]);
    expect(fetch).toHaveBeenCalledWith('/api/ai/tasks/task-1/events', expect.objectContaining({
      credentials: 'same-origin',
      headers: { Accept: 'text/event-stream' },
    }));
  });

  it('rejects an event stream that disconnects before a terminal status', async () => {
    const task = { id: 'task-1', status: 'running', output: '部分内容', progressVersion: 1 };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`data: ${JSON.stringify({ task })}\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })));
    const onTask = vi.fn();
    await expect(streamTask('task-1', { onTask })).rejects.toThrow('提前断开');
    expect(onTask).toHaveBeenCalledWith(task);
  });
});
