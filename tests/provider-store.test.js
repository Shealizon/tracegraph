import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addProvider, discoverProviderModels, enableModel, loadProviderState, renameEnabledModel, resolveModelConfig,
} from '../src/ai/providerStore.js';
import { streamCompletion, toAnthropicMessages, toGeminiContents } from '../src/ai/modelClient.js';

afterEach(() => vi.unstubAllGlobals());

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

describe('provider and protocol adapters', () => {
  it('migrates the legacy OpenAI-compatible model without storing its key', () => {
    const state = loadProviderState(memoryStorage(), 'providers', { baseUrl: 'https://gateway.test/v1', model: 'research-model' });
    expect(state.providers[0]).toMatchObject({ protocol: 'openai-chat', baseUrl: 'https://gateway.test/v1' });
    expect(state.enabledModels[0].modelId).toBe('research-model');
  });

  it('keeps providers separate from enabled models and resolves a session key', () => {
    const state = loadProviderState(memoryStorage(), 'providers');
    const provider = addProvider(state, { name: 'Claude', protocol: 'anthropic-messages' });
    const model = enableModel(state, provider.id, 'claude-test');
    const keys = memoryStorage({ [`keys:${provider.id}`]: 'secret' });
    expect(resolveModelConfig(state, model.id, keys, 'keys')).toMatchObject({ protocol: 'anthropic-messages', model: 'claude-test', apiKey: 'secret' });
    expect(renameEnabledModel(state, model.id, '我的 Claude')).toBe(true);
    expect(resolveModelConfig(state, model.id, keys, 'keys').displayName).toBe('我的 Claude');
  });

  it('marks cloud providers and forces the unique Codex provider to server runtime', () => {
    const state = loadProviderState(memoryStorage(), 'providers');
    const cloud = addProvider(state, { name: 'Cloud OpenAI', protocol: 'openai-chat', runtime: 'server' });
    const cloudModel = enableModel(state, cloud.id, 'gpt-test');
    expect(resolveModelConfig(state, cloudModel.id, memoryStorage(), 'keys')).toMatchObject({ runtime: 'server', providerId: cloud.id });
    const codex = addProvider(state, { name: 'Codex', protocol: 'server-codex', runtime: 'local' });
    expect(codex).toMatchObject({ id: 'server-codex', runtime: 'server', modelsCache: [] });
  });

  it('discovers Gemini generation models through the provider model endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ models: [
      { name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/embed-a', supportedGenerationMethods: ['embedContent'] },
    ] }) })));
    vi.stubGlobal('performance', { now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(25) });
    const result = await discoverProviderModels({ protocol: 'gemini', baseUrl: 'https://google.test/v1beta' }, 'key');
    expect(result).toEqual({ models: ['gemini-a'], latencyMs: 25 });
    expect(fetch).toHaveBeenCalledWith('https://google.test/v1beta/models?pageSize=1000', expect.objectContaining({ headers: { 'x-goog-api-key': 'key' } }));
  });

  it('converts assistant tool calls and tool results for Anthropic', () => {
    const converted = toAnthropicMessages([
      { role: 'system', content: 'system' },
      { role: 'assistant', content: 'checking', tool_calls: [{ id: 'c1', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
    ]);
    expect(converted[0].content[1]).toEqual({ type: 'tool_use', id: 'c1', name: 'lookup', input: { q: 'x' } });
    expect(converted[1].content[0].type).toBe('tool_result');
  });

  it('converts tool calls and responses for Gemini', () => {
    const converted = toGeminiContents([
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
    ]);
    expect(converted[0].parts[0].functionCall).toEqual({ name: 'lookup', args: { q: 'x' } });
    expect(converted[1].parts[0].functionResponse.name).toBe('lookup');
  });

  it('parses Anthropic text and streamed tool arguments', async () => {
    const events = [
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool-1', name: 'lookup', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' } },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));
    const chunks = [];
    const result = await streamCompletion({ protocol: 'anthropic-messages', baseUrl: 'https://anthropic.test/v1', apiKey: 'key', model: 'claude-test' }, [{ role: 'user', content: 'test' }], [], (text) => chunks.push(text));
    expect(chunks).toEqual(['你好']);
    expect(result.toolCalls[0]).toMatchObject({ id: 'tool-1', name: 'lookup', arguments: '{"q":"x"}' });
  });

  it('parses Gemini text and function calls', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([{ candidates: [{ content: { parts: [{ text: '完成' }, { functionCall: { name: 'lookup', args: { q: 'x' } } }] } }] }])));
    const result = await streamCompletion({ protocol: 'gemini', baseUrl: 'https://google.test/v1beta', apiKey: 'key', model: 'gemini-test' }, [{ role: 'user', content: 'test' }], [], vi.fn());
    expect(result.content).toBe('完成');
    expect(result.toolCalls[0]).toMatchObject({ name: 'lookup', arguments: '{"q":"x"}' });
  });
});

function sseResponse(events) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
  let sent = false;
  return { ok: true, body: { getReader: () => ({ read: async () => sent ? { done: true } : (sent = true, { done: false, value: bytes }) }) } };
}
