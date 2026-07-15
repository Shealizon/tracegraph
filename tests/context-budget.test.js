import { describe, expect, it } from 'vitest';
import { contextUsage, estimateContextTokens, estimateTextTokens, formatTokenCount, resolveContextWindow } from '../src/ai/contextBudget.js';

describe('context budget helpers', () => {
  it('uses explicit and known model context windows', () => {
    expect(resolveContextWindow({ model: 'custom', contextWindow: 64_000 })).toBe(64_000);
    expect(resolveContextWindow({ model: 'gemini-2.5-pro' })).toBe(1_048_576);
    expect(resolveContextWindow({ model: 'gpt-4.1-mini' })).toBe(1_047_576);
    expect(resolveContextWindow({ model: 'unknown-model' })).toBe(128_000);
  });

  it('estimates CJK and non-CJK text without returning zero for content', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('你好世界')).toBeGreaterThan(0);
    expect(estimateTextTokens('a'.repeat(400))).toBe(100);
  });

  it('includes system, history, user text and tool definitions in the estimate', () => {
    const short = estimateContextTokens({ system: 'system', history: [], userText: 'question' });
    const long = estimateContextTokens({ system: 'system', history: [{ role: 'user', content: 'history '.repeat(20) }], userText: 'question', tools: [{ function: { name: 'search', parameters: { type: 'object' } } }] });
    expect(long).toBeGreaterThan(short);
  });

  it('calculates a bounded display model and readable token labels', () => {
    expect(contextUsage(90, 100)).toMatchObject({ ratio: 0.9, percent: 90 });
    expect(formatTokenCount(128_000)).toBe('128k');
    expect(formatTokenCount(1_048_576)).toBe('1m');
  });
});
