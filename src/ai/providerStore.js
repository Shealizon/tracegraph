const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1';

export const PROVIDER_PROTOCOLS = [
  { id: 'openai-chat', label: 'OpenAI-compatible', defaultBaseUrl: DEFAULT_OPENAI_URL },
  { id: 'anthropic-messages', label: 'Anthropic Messages', defaultBaseUrl: 'https://api.anthropic.com/v1' },
  { id: 'gemini', label: 'Google Gemini', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
];

export function createProviderState() {
  return { version: 1, providers: [], enabledModels: [], activeModelId: '' };
}

export function loadProviderState(storage, key, legacy = {}) {
  let parsed;
  try { parsed = JSON.parse(storage.getItem(key) || 'null'); } catch { parsed = null; }
  const state = normalizeProviderState(parsed);
  if (!state.providers.length && (legacy.baseUrl || legacy.model)) {
    const provider = createProvider({
      name: hostnameLabel(legacy.baseUrl) || 'OpenAI-compatible',
      protocol: 'openai-chat',
      baseUrl: legacy.baseUrl || DEFAULT_OPENAI_URL,
    });
    state.providers.push(provider);
    if (legacy.model) {
      const model = enableModel(state, provider.id, legacy.model, legacy.model);
      state.activeModelId = model.id;
    }
  }
  return state;
}

export function saveProviderState(storage, key, state) {
  storage.setItem(key, JSON.stringify(normalizeProviderState(state)));
}

export function createProvider(input = {}) {
  const protocol = PROVIDER_PROTOCOLS.some((item) => item.id === input.protocol) ? input.protocol : 'openai-chat';
  const defaultUrl = PROVIDER_PROTOCOLS.find((item) => item.id === protocol)?.defaultBaseUrl || DEFAULT_OPENAI_URL;
  return {
    id: input.id || makeId('provider'),
    name: String(input.name || PROVIDER_PROTOCOLS.find((item) => item.id === protocol)?.label || '模型服务').trim(),
    protocol,
    baseUrl: normalizeBaseUrl(input.baseUrl || defaultUrl),
    modelsCache: uniqueStrings(input.modelsCache || []),
    status: input.status || 'unknown',
    statusText: input.statusText || '',
    checkedAt: input.checkedAt || '',
  };
}

export function addProvider(state, input) {
  const provider = createProvider(input);
  state.providers.push(provider);
  return provider;
}

export function updateProvider(state, id, patch) {
  const provider = state.providers.find((item) => item.id === id);
  if (!provider) return null;
  const next = createProvider({ ...provider, ...patch, id });
  Object.assign(provider, next);
  return provider;
}

export function removeProvider(state, id) {
  state.providers = state.providers.filter((item) => item.id !== id);
  state.enabledModels = state.enabledModels.filter((item) => item.providerId !== id);
  if (!state.enabledModels.some((item) => item.id === state.activeModelId)) state.activeModelId = state.enabledModels[0]?.id || '';
}

export function enableModel(state, providerId, modelId, displayName = '') {
  const existing = state.enabledModels.find((item) => item.providerId === providerId && item.modelId === modelId);
  if (existing) return existing;
  const model = {
    id: makeId('model'), providerId, modelId: String(modelId).trim(),
    displayName: String(displayName || modelId).trim(),
  };
  state.enabledModels.push(model);
  if (!state.activeModelId) state.activeModelId = model.id;
  return model;
}

export function disableModel(state, id) {
  state.enabledModels = state.enabledModels.filter((item) => item.id !== id);
  if (state.activeModelId === id) state.activeModelId = state.enabledModels[0]?.id || '';
}

export function renameEnabledModel(state, id, displayName) {
  const model = state.enabledModels.find((item) => item.id === id);
  const value = String(displayName || '').trim().replace(/\s+/g, ' ').slice(0, 64);
  if (!model || !value) return false;
  model.displayName = value;
  return true;
}

export function resolveModelConfig(state, enabledModelId, keyStorage, keyPrefix) {
  const model = state.enabledModels.find((item) => item.id === enabledModelId)
    || state.enabledModels.find((item) => item.id === state.activeModelId)
    || state.enabledModels[0];
  if (!model) return null;
  const provider = state.providers.find((item) => item.id === model.providerId);
  if (!provider) return null;
  return {
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    apiKey: keyStorage.getItem(`${keyPrefix}:${provider.id}`) || '',
    model: model.modelId,
    displayName: model.displayName || model.modelId,
    providerName: provider.name,
    enabledModelId: model.id,
  };
}

export async function discoverProviderModels(provider, apiKey, signal) {
  if (!provider?.baseUrl) throw new Error('请填写 Base URL');
  if (!apiKey) throw new Error('请填写 API Key');
  const base = normalizeBaseUrl(provider.baseUrl);
  const headers = protocolHeaders(provider.protocol, apiKey);
  const started = performance.now();
  let url = `${base}/models`;
  if (provider.protocol === 'gemini') url += '?pageSize=1000';
  const response = await fetch(url, { headers, signal });
  if (!response.ok) throw new Error(`模型列表请求失败（${response.status}）：${(await response.text()).slice(0, 300)}`);
  const data = await response.json();
  const models = provider.protocol === 'gemini'
    ? (data.models || []).filter((item) => !item.supportedGenerationMethods || item.supportedGenerationMethods.includes('generateContent')).map((item) => String(item.name || '').replace(/^models\//, ''))
    : (data.data || []).map((item) => item.id);
  return { models: uniqueStrings(models).sort(), latencyMs: Math.round(performance.now() - started) };
}

export function protocolHeaders(protocol, apiKey) {
  if (protocol === 'anthropic-messages') return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
  if (protocol === 'gemini') return { 'x-goog-api-key': apiKey };
  return { Authorization: `Bearer ${apiKey}` };
}

function normalizeProviderState(value) {
  const state = value && typeof value === 'object' ? value : createProviderState();
  const providers = Array.isArray(state.providers) ? state.providers.map(createProvider) : [];
  const providerIds = new Set(providers.map((item) => item.id));
  const enabledModels = Array.isArray(state.enabledModels) ? state.enabledModels.filter((item) => providerIds.has(item.providerId) && item.modelId).map((item) => ({
    id: item.id || makeId('model'), providerId: item.providerId, modelId: String(item.modelId), displayName: String(item.displayName || item.modelId),
  })) : [];
  return { version: 1, providers, enabledModels, activeModelId: enabledModels.some((item) => item.id === state.activeModelId) ? state.activeModelId : enabledModels[0]?.id || '' };
}

function normalizeBaseUrl(value) { return String(value || '').trim().replace(/\/+$/, ''); }
function uniqueStrings(items) { return [...new Set(items.map(String).map((item) => item.trim()).filter(Boolean))]; }
function makeId(prefix) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function hostnameLabel(url) { try { return new URL(url).hostname.replace(/^api\./, ''); } catch { return ''; } }
