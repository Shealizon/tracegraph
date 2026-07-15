import { serverApi } from './api.js';
import { isAuthenticated } from './session.js';

const PROVIDERS_KEY = 'paper-graph-ai-providers';

export async function hydrateCloudAiState(projectId) {
  if (!isAuthenticated()) return;
  await Promise.all([
    hydrateKey(`conversations:${projectId}`, `paper-graph-ai-conversations:${projectId}`),
    hydrateKey('providers', PROVIDERS_KEY),
  ]);
}

export function saveCloudConversations(projectId, state) {
  const latest = newestConversationTime(state) || Date.now();
  return saveCloudState(`conversations:${projectId}`, { ...state, updatedAt: new Date(latest).toISOString() });
}

export function saveCloudProviders(state) {
  return saveCloudState('providers', { ...state, updatedAt: new Date().toISOString() });
}

async function hydrateKey(cloudKey, localKey) {
  let remote;
  try { remote = (await serverApi.getState(cloudKey)).value; } catch { return; }
  let local;
  try { local = JSON.parse(localStorage.getItem(localKey) || 'null'); } catch { local = null; }
  const localTime = cloudKey.startsWith('conversations:') ? newestConversationTime(local) : time(local?.updatedAt);
  const remoteTime = cloudKey.startsWith('conversations:') ? newestConversationTime(remote) : time(remote?.updatedAt);
  if (remote && remoteTime > localTime) localStorage.setItem(localKey, JSON.stringify(remote));
  else if (local && localTime > remoteTime) await serverApi.saveState(cloudKey, { ...local, updatedAt: new Date(localTime).toISOString() });
}

function saveCloudState(key, value) {
  if (!isAuthenticated()) return Promise.resolve();
  return serverApi.saveState(key, value).catch((error) => console.warn(`failed to save cloud state ${key}`, error));
}

function newestConversationTime(state) {
  return Math.max(time(state?.updatedAt), ...(state?.conversations || []).map((conversation) => time(conversation.updatedAt)), 0);
}
function time(value) { const parsed = Date.parse(value || 0); return Number.isFinite(parsed) ? parsed : 0; }
