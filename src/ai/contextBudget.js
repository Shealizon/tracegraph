export const DEFAULT_CONTEXT_WINDOW = 128_000;

const MODEL_CONTEXT_WINDOWS = [
  [/gemini/i, 1_048_576],
  [/(claude|anthropic)/i, 200_000],
  [/gpt-4\.1/i, 1_047_576],
  [/gpt-5/i, 400_000],
  [/o[1-4](?:-|$)/i, 200_000],
  [/gpt-4o/i, 128_000],
  [/(deepseek|qwen|llama|mistral)/i, 128_000],
];

export function resolveContextWindow(modelConfig) {
  const explicit = Number(modelConfig?.contextWindow || modelConfig?.contextLength || modelConfig?.maxContextTokens);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const model = `${modelConfig?.model || ''} ${modelConfig?.displayName || ''}`;
  const namedLimit = /(?:^|[-_])([0-9]{2,4})k(?:$|[-_])/i.exec(model)?.[1];
  if (namedLimit) return Number(namedLimit) * 1_000;
  return MODEL_CONTEXT_WINDOWS.find(([pattern]) => pattern.test(model))?.[1] || DEFAULT_CONTEXT_WINDOW;
}

export function estimateTextTokens(value) {
  const text = String(value ?? '');
  if (!text) return 0;
  let cjk = 0;
  for (const char of text) if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)) cjk += 1;
  const other = text.length - cjk;
  return Math.max(1, Math.ceil(cjk / 1.5 + other / 4));
}

export function estimateContextTokens({ system = '', history = [], userText = '', tools = [] } = {}) {
  const messages = history.map((message) => `${message.role || 'message'}:\n${message.content || ''}`).join('\n\n');
  const toolText = tools.length ? JSON.stringify(tools) : '';
  return estimateTextTokens([system, messages, userText, toolText].filter(Boolean).join('\n\n'));
}

export function contextUsage(tokens, total) {
  const safeTokens = Math.max(0, Number(tokens) || 0);
  const safeTotal = Math.max(1, Number(total) || DEFAULT_CONTEXT_WINDOW);
  const ratio = safeTokens / safeTotal;
  return { tokens: safeTokens, total: safeTotal, ratio, percent: Math.round(ratio * 100) };
}

export function formatTokenCount(value) {
  const tokens = Math.max(0, Number(value) || 0);
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}m`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(Math.round(tokens));
}
