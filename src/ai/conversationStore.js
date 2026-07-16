import { normalizeFileAccessMode } from './fileAccess.js';

const VERSION = 1;

export function createConversation({ id = createId(), title = '新对话', messages = [], modelId = '', fileAccessMode = 'ask' } = {}) {
  const now = new Date().toISOString();
  return {
    id,
    title,
    titleMode: title === '新对话' ? 'auto' : 'manual',
    messages: Array.isArray(messages) ? messages : [],
    attachments: [],
    contextAttachments: [],
    modelId,
    fileAccessMode: normalizeFileAccessMode(fileAccessMode),
    createdAt: now,
    updatedAt: now,
  };
}

export function loadConversationState(storage, key, legacyMessages = []) {
  let parsed;
  try { parsed = JSON.parse(storage?.getItem(key) || 'null'); } catch { parsed = null; }
  if (parsed?.version === VERSION && Array.isArray(parsed.conversations)) {
    let conversations = parsed.conversations.map(normalizeConversation).filter(Boolean);
    const nonEmpty = conversations.filter((conversation) => !isConversationEmpty(conversation));
    if (nonEmpty.length) conversations = nonEmpty;
    if (!conversations.length) conversations.push(createConversation());
    return {
      version: VERSION,
      activeId: conversations.some((item) => item.id === parsed.activeId) ? parsed.activeId : conversations[0].id,
      conversations,
    };
  }
  const migrated = createConversation({
    title: deriveConversationTitle(legacyMessages.find((message) => message.role === 'user')?.content) || '新对话',
    messages: Array.isArray(legacyMessages) ? legacyMessages : [],
  });
  migrated.titleMode = migrated.messages.length ? 'auto-generated' : 'auto';
  return { version: VERSION, activeId: migrated.id, conversations: [migrated] };
}

export function saveConversationState(storage, key, state) {
  const nonEmpty = state.conversations.filter((conversation) => !isConversationEmpty(conversation));
  const conversations = nonEmpty.length ? nonEmpty : [activeConversation(state) || state.conversations[0]].filter(Boolean);
  storage?.setItem(key, JSON.stringify({
    version: VERSION,
    activeId: conversations.some((conversation) => conversation.id === state.activeId) ? state.activeId : conversations[0]?.id || '',
    conversations: conversations.map((conversation) => ({ ...conversation, messages: conversation.messages.slice(-120) })),
  }));
}

export function isConversationEmpty(conversation) {
  if (!conversation) return true;
  const hasDialog = (conversation.messages || []).some((message) => message.role === 'user' || message.role === 'assistant');
  return !hasDialog && !(conversation.attachments || []).length && !(conversation.contextAttachments || []).length;
}

export function activeConversation(state) {
  return state.conversations.find((conversation) => conversation.id === state.activeId) || state.conversations[0];
}

export function addConversation(state, options = {}) {
  const conversation = createConversation(options);
  state.conversations.unshift(conversation);
  state.activeId = conversation.id;
  return conversation;
}

export function removeConversation(state, id) {
  state.conversations = state.conversations.filter((conversation) => conversation.id !== id);
  if (!state.conversations.length) state.conversations.push(createConversation());
  if (!state.conversations.some((conversation) => conversation.id === state.activeId)) state.activeId = state.conversations[0].id;
  return activeConversation(state);
}

export function updateAutomaticTitle(conversation) {
  if (!conversation || conversation.titleMode === 'manual') return conversation?.title || '';
  const firstUser = conversation.messages.find((message) => message.role === 'user');
  const title = deriveConversationTitle(firstUser?.content);
  if (title) {
    conversation.title = title;
    conversation.titleMode = 'auto-generated';
  }
  return conversation.title;
}

export function renameConversation(conversation, title) {
  const value = String(title || '').trim().replace(/\s+/g, ' ').slice(0, 64);
  if (!value) return false;
  conversation.title = value;
  conversation.titleMode = 'manual';
  conversation.updatedAt = new Date().toISOString();
  return true;
}

export function deriveConversationTitle(content, maxLength = 28) {
  const clean = String(content || '').replace(/[#>*_`\[\]()]/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const first = clean.split(/(?<=[。！？!?；;])\s*/u)[0] || clean;
  return first.length > maxLength ? `${first.slice(0, maxLength).trim()}…` : first;
}

function normalizeConversation(value) {
  if (!value || typeof value !== 'object') return null;
  const conversation = createConversation({
    id: value.id || createId(),
    title: value.title || '新对话',
    messages: value.messages,
    modelId: value.modelId || '',
    fileAccessMode: value.fileAccessMode,
  });
  return {
    ...conversation,
    ...value,
    messages: Array.isArray(value.messages) ? value.messages : [],
    attachments: Array.isArray(value.attachments) ? value.attachments : [],
    contextAttachments: Array.isArray(value.contextAttachments) ? value.contextAttachments : [],
    fileAccessMode: normalizeFileAccessMode(value.fileAccessMode),
  };
}

function createId() {
  return globalThis.crypto?.randomUUID?.() || `chat-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
