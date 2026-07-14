import { describe, expect, it } from 'vitest';
import {
  activeConversation, addConversation, deriveConversationTitle, loadConversationState,
  isConversationEmpty, removeConversation, renameConversation, saveConversationState, updateAutomaticTitle,
} from '../src/ai/conversationStore.js';

function memoryStorage(value = null) {
  return { getItem: () => value, setItem: () => {} };
}

describe('AI conversation store', () => {
  it('migrates the legacy single conversation', () => {
    const legacy = [{ role: 'user', content: '这是旧对话的第一个问题。后续说明' }, { role: 'assistant', content: '回答' }];
    const state = loadConversationState(memoryStorage(), 'key', legacy);
    expect(state.conversations).toHaveLength(1);
    expect(activeConversation(state).messages).toEqual(legacy);
    expect(activeConversation(state).title).toBe('这是旧对话的第一个问题。');
  });

  it('creates, switches, renames and removes conversations', () => {
    const state = loadConversationState(memoryStorage(), 'key');
    const first = activeConversation(state);
    const second = addConversation(state);
    expect(activeConversation(state)).toBe(second);
    expect(renameConversation(second, ' 手动标题 ')).toBe(true);
    expect(second).toMatchObject({ title: '手动标题', titleMode: 'manual' });
    removeConversation(state, second.id);
    expect(activeConversation(state).id).toBe(first.id);
  });

  it('generates a concise title from the first user sentence without overriding manual titles', () => {
    const conversation = { title: '新对话', titleMode: 'auto', messages: [{ role: 'user', content: '请分析唯一延拓性？还要比较近期论文。' }] };
    expect(updateAutomaticTitle(conversation)).toBe('请分析唯一延拓性？');
    conversation.titleMode = 'manual';
    conversation.title = '我的研究';
    conversation.messages[0].content = '另一个问题';
    expect(updateAutomaticTitle(conversation)).toBe('我的研究');
    expect(deriveConversationTitle('a'.repeat(40))).toHaveLength(29);
  });

  it('does not persist an unused empty draft beside real conversations', () => {
    const values = new Map();
    const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
    const state = loadConversationState(storage, 'key');
    activeConversation(state).messages.push({ role: 'user', content: 'real' });
    addConversation(state);
    expect(isConversationEmpty(activeConversation(state))).toBe(true);
    saveConversationState(storage, 'key', state);
    const saved = JSON.parse(values.get('key'));
    expect(saved.conversations).toHaveLength(1);
    expect(saved.conversations[0].messages[0].content).toBe('real');
  });
});
