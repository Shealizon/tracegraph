import { createBrowserWorkspace } from '../ai/workspace.js';
import { createClientTools } from '../ai/tools.js';
import { compactConversation as compactModelContext, DEFAULT_SYSTEM_PROMPT, runAgentTurn } from '../ai/modelClient.js';
import { contextUsage, estimateContextTokens, formatTokenCount, resolveContextWindow } from '../ai/contextBudget.js';
import { buildGraphContext } from '../ai/graphContext.js';
import {
  aiQuoteAttachment, appendUniqueContext, contextPrompt, graphFileAttachment, graphMemberAttachment, graphNodeAttachment, graphNoteAttachment, graphReferenceAttachment, graphSelectionAttachment, graphTagAttachment,
  mentionQueryAt, replaceMention, searchMentionCandidates,
} from '../ai/contextAttachments.js';
import { appendReasoningBlock, appendTextBlock, mergeToolSources, messageBlocks, serializeMessageDebug, upsertToolBlock } from '../ai/messageBlocks.js';
import { renderMarkdownInto } from '../render/markdown.js';
import { confirmDialog, toast } from './feedback.js';
import { graphReferenceToMember, resolveTagNoteReference } from '../data/graphReference.js';
import { memberKey } from '../data/schema.js';
import { upsertNote } from '../data/notes.js';
import { bindGraphReferencePaste } from './graphClipboard.js';
import {
  activeConversation, addConversation, isConversationEmpty, loadConversationState, removeConversation,
  renameConversation, saveConversationState, updateAutomaticTitle,
} from '../ai/conversationStore.js';
import {
  PROVIDER_PROTOCOLS, addProvider, disableModel, discoverProviderModels, enableModel,
  loadProviderState, removeProvider, renameEnabledModel, resolveModelConfig, saveProviderState, updateProvider,
} from '../ai/providerStore.js';
import { serverApi } from '../cloud/api.js';
import { sessionSnapshot } from '../cloud/session.js';
import { saveCloudConversations, saveCloudProviders } from '../cloud/aiState.js';

const SETTINGS_KEY = 'paper-graph-ai-settings';
const KEY_SESSION = 'paper-graph-ai-api-key';
const PROVIDERS_KEY = 'paper-graph-ai-providers';
const PROVIDER_KEY_SESSION = 'paper-graph-ai-provider-key';
const WIDTH_KEY = 'paper-graph-ai-width';
const OPEN_KEY = 'paper-graph-ai-open';
const LAYOUT_KEY = 'paper-graph-ai-layout';
const COLLAPSED_KEY = 'paper-graph-ai-collapsed';
const STARTER_PROMPTS = [
  '概括当前图谱的核心结构',
  '解释当前图谱中最重要的几个概念及它们之间的关系',
  '沿着依赖关系梳理一条适合阅读当前图谱的路径',
  '指出当前图谱中值得进一步核对或补充的关键问题',
  '用直观语言解释当前图谱涉及的核心定理或公式',
  '联网搜索当前主题近几年的研究进展',
];

export function buildAiPanel(ctx) {
  const existing = document.querySelector('.ai-panel');
  if (existing) return existing._aiPanelApi;
  const projectId = ctx.project?.id || 'default';
  const historyKey = `paper-graph-ai-history:${projectId}`;
  const conversationsKey = `paper-graph-ai-conversations:${projectId}`;
  const conversationState = loadConversationState(localStorage, conversationsKey, loadJson(historyKey, []));
  for (const conversation of conversationState.conversations) {
    conversation.messages = conversation.messages.filter((message) => !isLegacyFileImportNotice(message));
  }
  const legacySettings = { baseUrl: 'https://api.openai.com/v1', model: '', ...loadJson(SETTINGS_KEY, {}) };
  const providerState = loadProviderState(localStorage, PROVIDERS_KEY, legacySettings);
  if (!activeConversation(conversationState).modelId && providerState.activeModelId) activeConversation(conversationState).modelId = providerState.activeModelId;
  if (providerState.providers.length === 1 && !sessionStorage.getItem(`${PROVIDER_KEY_SESSION}:${providerState.providers[0].id}`)) {
    const legacyKey = sessionStorage.getItem(KEY_SESSION);
    if (legacyKey) sessionStorage.setItem(`${PROVIDER_KEY_SESSION}:${providerState.providers[0].id}`, legacyKey);
  }
  let workspace = createBrowserWorkspace(`${projectId}--${activeConversation(conversationState).id}`);
  let selectedNodeId = '';
  const tasks = new Map();
  const state = {
    followOutput: true,
    scrollFrame: 0,
    scrollTarget: 0,
    editingIndex: -1,
    mention: null,
    mentionItems: [],
    mentionIndex: 0,
    mentionRequest: 0,
    layoutResizeTimer: 0,
    quoteSelection: null,
    compacting: false,
    compactAborter: null,
    contextSnapshot: null,
    contextEstimateFrame: 0,
  };
  Object.defineProperty(state, 'messages', {
    get: () => activeConversation(conversationState).messages,
    set: (messages) => { activeConversation(conversationState).messages = messages; },
  });
  const renderQueued = new WeakSet();
  const expandedProviders = new Set();
  const contextToolDefinitions = createClientTools(workspace, { graphModel: ctx.model }).definitions;

  const launcher = button('ai-launcher', 'AI', '打开 AI Assistant');
  launcher.setAttribute('aria-label', '打开 AI Assistant');
  launcher.innerHTML = `${sparkIcon()}<span>AI</span>`;
  const panel = document.createElement('aside');
  panel.className = 'ai-panel';
  panel.setAttribute('aria-label', 'AI Assistant');
  panel.innerHTML = `
    <div class="ai-resize" data-resize aria-hidden="true"></div>
    <header class="ai-head">
      <div class="ai-head-primary">
        <button class="icon-btn" data-collapse title="折叠面板">${panelCollapseIcon()}</button>
        <button class="icon-btn" data-layout title="面板形态">${panelLayoutIcon()}</button>
        <button class="ai-brand" data-conversations title="切换或重命名对话">${sparkIcon()}<strong data-conversation-title>新对话</strong>${chevronIcon()}</button>
        <button class="icon-btn ai-new-chat" data-new title="新建对话">${newChatIcon()}</button>
      </div>
      <div class="ai-head-actions">
        <span class="ai-panel-status" data-panel-status></span>
        <button class="icon-btn" data-workspace title="当前对话文件">${folderIcon()}</button>
        <button class="icon-btn" data-settings title="模型设置">${settingsIcon()}</button>
        <button class="icon-btn" data-close title="关闭">${closeIcon()}</button>
      </div>
    </header>
    <nav class="ai-turn-rail" data-turn-rail aria-label="对话轮次导航"></nav>
    <section class="ai-messages" data-messages aria-live="polite"></section>
    <section class="ai-subpanel" data-subpanel hidden></section>
    <button class="ai-quote-selection" data-quote-selection hidden>${quoteIcon()}<span>引用</span></button>
    <footer class="ai-composer">
      <div class="ai-mention-menu" data-mention-menu hidden></div>
      <div class="ai-attachment-row" data-attachments></div>
      <div class="ai-input-shell">
        <textarea data-input rows="1" placeholder="询问、搜索或分析本对话文件…"></textarea>
        <div class="ai-input-actions">
          <button class="icon-btn" data-attach title="添加文件或 PDF">${paperclipIcon()}</button>
          <button class="ai-model-label" data-model-label title="切换模型">未配置模型</button>
          <button class="ai-context-toggle" data-context-toggle title="查看上下文使用量" aria-label="查看上下文使用量" aria-expanded="false"><span class="ai-context-ring" data-context-ring aria-hidden="true"></span></button>
          <button class="ai-send" data-send title="发送">${sendIcon()}</button>
        </div>
      </div>
      <input data-file type="file" multiple hidden accept=".pdf,.txt,.md,.tex,.json,.csv,.js,.ts,.html,.css,application/pdf,text/*,application/json">
      <small class="ai-disclaimer">文件仅属于当前对话并保存在本机浏览器中。</small>
    </footer>`;

  document.body.append(launcher, panel);
  const messagesEl = panel.querySelector('[data-messages]');
  const input = panel.querySelector('[data-input]');
  const send = panel.querySelector('[data-send]');
  const fileInput = panel.querySelector('[data-file]');
  const subpanel = panel.querySelector('[data-subpanel]');
  const attachmentsEl = panel.querySelector('[data-attachments]');
  const turnRail = panel.querySelector('[data-turn-rail]');
  const mentionMenu = panel.querySelector('[data-mention-menu]');
  const quoteSelectionButton = panel.querySelector('[data-quote-selection]');
  const contextToggle = panel.querySelector('[data-context-toggle]');

  applyWidth(panel, Number(localStorage.getItem(WIDTH_KEY)) || Math.round(innerWidth / 3));
  const initialLayout = localStorage.getItem(LAYOUT_KEY) || 'floating';
  setLayout(initialLayout, { persist: false });
  setCollapsed(initialLayout === 'docked' ? false : localStorage.getItem(COLLAPSED_KEY) === '1', { persist: false });
  setOpen(localStorage.getItem(OPEN_KEY) === '1');
  syncModelLabel();
  syncConversationUi();
  renderMessages({ follow: true, immediate: true });

  launcher.addEventListener('click', () => setOpen(true));
  panel.querySelector('[data-close]').addEventListener('click', () => setOpen(false));
  panel.querySelector('[data-collapse]').addEventListener('click', () => {
    const collapse = !panel.classList.contains('is-collapsed');
    if (collapse && panel.dataset.layout === 'docked') setLayout('floating');
    setCollapsed(collapse);
  });
  panel.querySelector('[data-layout]').addEventListener('click', () => {
    if (panel.classList.contains('is-collapsed')) return;
    showLayoutPicker();
  });
  panel.querySelector('[data-settings]').addEventListener('click', () => showSettings(true));
  panel.querySelector('[data-model-label]').addEventListener('click', showModelPicker);
  contextToggle.addEventListener('click', showContextPanel);
  panel.querySelector('[data-workspace]').addEventListener('click', () => showWorkspace(true));
  panel.querySelector('[data-conversations]').addEventListener('click', () => {
    if (panel.classList.contains('is-collapsed')) { setCollapsed(false, { persist: false }); return; }
    showConversations();
  });
  panel.querySelector('[data-new]').addEventListener('click', () => {
    if (isConversationEmpty(activeConversation(conversationState))) {
      closeSubpanel();
      input.focus();
      return;
    }
    addConversation(conversationState, { modelId: activeConversation(conversationState).modelId || providerState.activeModelId || '' });
    switchConversation(conversationState.activeId);
    input.focus();
  });
  panel.querySelector('[data-attach]').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    for (const file of files) {
      try {
        const imported = await workspace.importFile(file);
        activeConversation(conversationState).attachments.push(imported);
        if (sessionSnapshot().user) uploadCloudFiles(workspace, [imported], `${projectId}--${activeConversation(conversationState).id}`).catch((error) => console.warn('cloud file upload failed', error));
      } catch (error) {
        state.messages.push({ role: 'notice', tone: 'error', createdAt: new Date().toISOString(), content: `文件导入失败：${error?.message || error}` });
      }
    }
    persist();
    renderAttachments();
    renderMessages();
  });

  send.addEventListener('click', submit);
  input.addEventListener('keydown', (event) => {
    if (!mentionMenu.hidden && handleMentionKey(event)) return;
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(150, input.scrollHeight)}px`;
    updateMentionMenu();
    scheduleContextUsageSync();
  });
  bindGraphReferencePaste(input, {
    insertMarkdown: false,
    onReference: (reference) => addContextAttachment(graphReferenceAttachment(ctx.model, reference, ctx.graph?.getTags?.() || [], ctx.getNotes?.() || [])),
  });
  input.addEventListener('click', updateMentionMenu);
  input.addEventListener('blur', () => setTimeout(() => closeMentionMenu(), 140));
  initResize(panel);

  messagesEl.addEventListener('scroll', () => {
    hideQuoteSelection();
    if (state.scrollFrame) return;
    state.followOutput = isNearBottom();
    syncActiveTurn();
  }, { passive: true });
  messagesEl.addEventListener('wheel', (event) => {
    if (event.deltaY !== 0) stopFollowing();
  }, { passive: true });
  messagesEl.addEventListener('pointerdown', stopFollowing, { passive: true });
  messagesEl.addEventListener('touchstart', stopFollowing, { passive: true });
  messagesEl.addEventListener('mouseup', () => setTimeout(updateQuoteSelection, 0));
  messagesEl.addEventListener('touchend', () => setTimeout(updateQuoteSelection, 80), { passive: true });
  quoteSelectionButton.addEventListener('pointerdown', (event) => event.preventDefault());
  quoteSelectionButton.addEventListener('click', () => {
    const selected = state.quoteSelection;
    const conversation = activeConversation(conversationState);
    const message = selected ? conversation.messages[selected.messageIndex] : null;
    if (selected && addContextAttachment(aiQuoteAttachment(message, selected.messageIndex, selected.text, conversation.title))) {
      window.getSelection()?.removeAllRanges();
    }
    hideQuoteSelection();
  });
  document.addEventListener('pointerdown', (event) => {
    if (subpanel.hidden || !subpanel.classList.contains('is-popover')) return;
    if (subpanel.contains(event.target) || event.target.closest('[data-conversations], [data-model-label], [data-context-toggle]')) return;
    closeSubpanel();
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !subpanel.hidden && subpanel.classList.contains('is-popover')) closeSubpanel();
  });

  async function submit() {
    return submitText(input.value);
  }

  async function submitText(rawText) {
    if (state.compacting) return;
    const running = tasks.get(activeConversation(conversationState).id);
    if (running) {
      running.aborter.abort();
      return;
    }
    const text = normalizeAiText(rawText);
    if (!text) return;
    if (getContextSnapshot().ratio >= 0.8 && activeConversation(conversationState).messages.some((message) => message.role === 'user' || message.role === 'assistant')) {
      const compacted = await runConversationCompaction({ automatic: true });
      if (!compacted) return;
    }
    closeSubpanel();
    input.value = '';
    input.style.height = 'auto';
    await startTurn(text);
  }

  async function runConversationCompaction({ automatic = false } = {}) {
    const conversation = activeConversation(conversationState);
    if (state.compacting || tasks.has(conversation.id)) return false;
    const messages = modelHistory(conversation.messages);
    if (!messages.length) return false;
    const modelConfig = currentModelConfig();
    if (!modelConfig) {
      toast('请先配置模型后再压缩上下文');
      return false;
    }
    state.compacting = true;
    state.compactAborter = new AbortController();
    const compactedMessage = {
      role: 'assistant',
      content: '',
      blocks: [],
      sources: [],
      model: modelConfig.displayName || modelConfig.model || '',
      compaction: true,
      compactionStatus: 'running',
      createdAt: new Date().toISOString(),
    };
    conversation.messages.push(compactedMessage);
    conversation.updatedAt = new Date().toISOString();
    persist();
    setContextPanelStatus(automatic ? '正在自动压缩上下文…' : '正在压缩上下文…');
    syncBusy();
    syncContextUsage();
    renderMessages({ follow: true, immediate: true });
    try {
      const summary = await compactModelContext({
        config: { ...modelConfig, contextPrompt: buildGraphContext(ctx.model, selectedNodeId) },
        transcript: buildCompactionTranscript(messages),
        signal: state.compactAborter.signal,
        onDelta: (delta) => {
          compactedMessage.content += delta;
          appendTextBlock(compactedMessage, delta);
          updateAssistantDom(conversation, compactedMessage);
        },
      });
      if (!summary.trim()) throw new Error('模型没有返回压缩摘要');
      if (compactedMessage.content.trim() !== summary.trim()) {
        compactedMessage.content = summary.trim();
        compactedMessage.blocks = [{ type: 'text', content: compactedMessage.content }];
      }
      compactedMessage.compactionStatus = 'done';
      conversation.updatedAt = new Date().toISOString();
      persist();
      renderMessages({ follow: true });
      toast(automatic ? '已自动压缩上下文' : '上下文已压缩');
      return true;
    } catch (error) {
      conversation.messages = conversation.messages.filter((message) => message !== compactedMessage);
      persist();
      renderMessages({ follow: true, immediate: true });
      if (error?.name !== 'AbortError') toast(`上下文压缩失败：${error?.message || error}`);
      return false;
    } finally {
      state.compacting = false;
      state.compactAborter = null;
      setContextPanelStatus('');
      syncBusy();
      syncContextUsage();
    }
  }

  function buildCompactionTranscript(messages) {
    const transcript = messages.map((message, index) => {
      const role = message.role === 'user' ? '用户' : '助手';
      const sources = message.sources?.length ? `\n来源：${JSON.stringify(message.sources)}` : '';
      const debug = serializeMessageDebug(message, { index });
      return `[${index + 1}] ${role}\n${debug}${sources}`;
    }).join('\n\n---\n\n');
    const maxCharacters = Math.max(24_000, Math.floor(resolveContextWindow(currentModelConfig()) * 3.2 * 0.78));
    if (transcript.length <= maxCharacters) return transcript;
    const head = transcript.slice(0, Math.min(12_000, Math.floor(maxCharacters * 0.25)));
    const tail = transcript.slice(-(maxCharacters - head.length - 80));
    return `${head}\n\n[…中间历史已省略，摘要必须说明这一点…]\n\n${tail}`;
  }

  function updateQuoteSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount || panel.classList.contains('is-collapsed')) {
      hideQuoteSelection();
      return;
    }
    const range = selection.getRangeAt(0);
    const startNode = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
    const endNode = range.endContainer.nodeType === Node.ELEMENT_NODE ? range.endContainer : range.endContainer.parentElement;
    const answer = startNode?.closest?.('.ai-message--assistant .ai-answer-block');
    if (!answer || !answer.contains(endNode)) { hideQuoteSelection(); return; }
    const row = answer.closest('.ai-message--assistant[data-message-index]');
    const text = selection.toString().trim();
    if (!row || !text) { hideQuoteSelection(); return; }
    const rect = range.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    state.quoteSelection = { messageIndex: Number(row.dataset.messageIndex), text };
    quoteSelectionButton.hidden = false;
    quoteSelectionButton.style.left = `${Math.max(42, Math.min(panelRect.width - 42, rect.left + rect.width / 2 - panelRect.left))}px`;
    quoteSelectionButton.style.top = `${Math.max(62, rect.top - panelRect.top - 38)}px`;
  }

  function hideQuoteSelection() {
    state.quoteSelection = null;
    quoteSelectionButton.hidden = true;
    quoteSelectionButton.removeAttribute('style');
  }

  async function startTurn(text, { regenerateIndex = -1, editUserIndex = -1 } = {}) {
    const conversation = activeConversation(conversationState);
    if (tasks.has(conversation.id) || !text.trim()) return;
    closeSubpanel();
    closeMentionMenu();
    const shouldFollow = isNearBottom();
    let history;
    let turnContexts = [];
    let turnFiles = [];
    if (editUserIndex >= 0) {
      const original = conversation.messages[editUserIndex];
      if (original?.role !== 'user') return;
      history = modelHistory(conversation.messages.slice(0, editUserIndex));
      turnContexts = original.contextAttachments || [];
      turnFiles = original.fileAttachments || [];
      conversation.messages = replaceUserMessageBranch(conversation.messages, editUserIndex, text.trim());
      conversation.messages[editUserIndex] = { ...conversation.messages[editUserIndex], contextAttachments: turnContexts, fileAttachments: turnFiles };
    } else if (regenerateIndex >= 0) {
      const userIndex = findPreviousUserIndex(regenerateIndex);
      if (userIndex < 0) return;
      history = modelHistory(conversation.messages.slice(0, userIndex));
      turnContexts = conversation.messages[userIndex].contextAttachments || [];
      turnFiles = conversation.messages[userIndex].fileAttachments || [];
      conversation.messages = conversation.messages.slice(0, userIndex + 1);
    } else {
      history = modelHistory(conversation.messages);
      turnContexts = [...(conversation.contextAttachments || [])];
      turnFiles = [...(conversation.attachments || [])];
      conversation.contextAttachments = [];
      conversation.attachments = [];
      conversation.messages.push({ role: 'user', content: text, contextAttachments: turnContexts, fileAttachments: turnFiles, createdAt: new Date().toISOString() });
      renderAttachments();
    }
    updateAutomaticTitle(conversation);
    conversation.updatedAt = new Date().toISOString();
    syncConversationUi();
    const modelConfig = currentModelConfig();
    const assistantMessage = { role: 'assistant', content: '', blocks: [], sources: [], model: modelConfig?.displayName || modelConfig?.model || '', createdAt: new Date().toISOString() };
    conversation.messages.push(assistantMessage);
    const aborter = new AbortController();
    tasks.set(conversation.id, { aborter, message: assistantMessage, status: 'running', retryAttempt: 0 });
    syncBusy();
    renderMessages({ follow: shouldFollow });

    const turnWorkspace = workspace;
    const tools = createClientTools(turnWorkspace, {
      graphModel: ctx.model,
      getGraphTags: () => ctx.graph?.getTags?.() || [],
      persistGraphTags: (tags) => ctx.persistTags?.(tags),
      getGraphNotes: () => ctx.getNotes?.() || [],
      persistGraphNotes: (notes) => ctx.persistNotes?.(notes),
      confirmTagNoteChange: ({ action, tag, member, note, title, content }) => confirmDialog({
        title: `${action === 'delete_tag_note' ? '删除' : action === 'create_tag_note' ? '创建' : '更新'}标签笔记`,
        message: `标签「${tag.label || tag.id}」\n实例：${memberKey(member)}\n\n${title ?? note?.title ?? ''}\n${String(content ?? note?.content ?? '').slice(0, 500)}`,
        okText: action === 'delete_tag_note' ? '删除' : '允许',
        danger: action === 'delete_tag_note',
      }),
      revealGraphNode: (node, labelId) => {
        selectedNodeId = node.id;
        ctx.modals?.openFromNode(node, labelId ? { scrollLabel: labelId } : {});
      },
      initialSources: history.flatMap((message) => message.sources || []),
      onQueued: (event) => updateToolEvent(conversation, assistantMessage, event, 'queued'),
      onStart: (event) => updateToolEvent(conversation, assistantMessage, event, 'running'),
      onEnd: (event) => updateToolEvent(conversation, assistantMessage, event, 'done'),
      onError: (event) => updateToolEvent(conversation, assistantMessage, event, 'error'),
      confirm: ({ path, preview }) => confirmDialog({
        title: '允许 AI 写入文件？',
        message: `${path}\n\n内容预览：\n${preview}`,
        okText: '允许写入',
      }),
    });

    try {
      const resolvedUserText = contextPrompt(text.trim(), [...turnContexts, ...turnFiles.map(graphFileAttachment).filter(Boolean)], ctx.model);
      if (modelConfig?.runtime === 'server') {
        if (!sessionSnapshot().user) throw new Error('云端模型需要先登录');
        const workspaceScope = `${projectId}--${conversation.id}`;
        await uploadCloudFiles(turnWorkspace, turnFiles, workspaceScope);
        const created = await serverApi.createTask({
          providerId: modelConfig.providerId,
          model: modelConfig.model,
          projectId,
          conversationId: conversation.id,
          workspaceScope,
          history,
          userText: resolvedUserText,
          systemPrompt: [modelConfig.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT, buildGraphContext(ctx.model, selectedNodeId)].filter(Boolean).join('\n\n'),
        });
        assistantMessage.cloudTaskId = created.task.id;
        assistantMessage.cloud = true;
        persistConversation(conversation);
        await saveCloudConversations(projectId, conversationState);
        const cloudTask = await waitForCloudTask(created.task.id, aborter.signal, (task) => {
          const activeTask = tasks.get(conversation.id);
          if (activeTask) activeTask.status = task.status === 'queued' ? 'queued' : 'running';
          syncBusy();
        });
        if (cloudTask.status === 'failed') throw new Error(cloudTask.error || '云端任务失败');
        if (cloudTask.status === 'cancelled') throw new DOMException('Aborted', 'AbortError');
        assistantMessage.cloudTaskStatus = cloudTask.status;
        assistantMessage.content = cloudTask.output || '操作已完成。';
        appendTextBlock(assistantMessage, assistantMessage.content);
        updateAssistantDom(conversation, assistantMessage);
      } else await runAgentTurn({
        config: { ...(modelConfig || {}), contextPrompt: buildGraphContext(ctx.model, selectedNodeId) },
        history,
        userText: resolvedUserText,
        tools,
        signal: aborter.signal,
        onDelta: (delta) => {
          assistantMessage.content += delta;
          appendTextBlock(assistantMessage, delta);
          updateAssistantDom(conversation, assistantMessage);
        },
        onReasoningDelta: (delta) => {
          appendReasoningBlock(assistantMessage, delta);
          updateAssistantDom(conversation, assistantMessage);
        },
        onStatus: (event) => {
          const task = tasks.get(conversation.id);
          if (!task) return;
          task.status = event.type === 'reconnecting' ? 'reconnecting' : 'running';
          task.retryAttempt = event.attempt || 0;
          syncBusy();
        },
      });
      if (!assistantMessage.content.trim()) {
        assistantMessage.content = '操作已完成。';
        appendTextBlock(assistantMessage, assistantMessage.content);
      }
    } catch (error) {
      const errorText = error?.name === 'AbortError' ? '\n\n（已停止）' : `\n\n请求失败：${error?.message || error}`;
      assistantMessage.content += errorText;
      appendTextBlock(assistantMessage, errorText);
    } finally {
      tasks.delete(conversation.id);
      syncBusy();
      persistConversation(conversation);
      updateAssistantDom(conversation, assistantMessage);
    }
  }

  function updateToolEvent(conversation, message, event, status) {
    upsertToolBlock(message, event, status);
    if (status === 'done') mergeToolSources(message, event);
    updateAssistantDom(conversation, message);
  }

  function updateAssistantDom(conversation, message) {
    if (activeConversation(conversationState).id !== conversation.id) return;
    scheduleContextUsageSync();
    if (renderQueued.has(message)) return;
    renderQueued.add(message);
    requestAnimationFrame(() => {
      renderQueued.delete(message);
      const shouldFollow = state.followOutput && isNearBottom();
      if (activeConversation(conversationState).id !== conversation.id) return;
      const index = conversation.messages.indexOf(message);
      const row = messagesEl.querySelector(`[data-message-index="${index}"]`);
      if (!row) { renderMessages(); return; }
      if (state.quoteSelection?.messageIndex === index) hideQuoteSelection();
      const body = row.querySelector('.ai-message-body');
      if (body) {
        if (message.compaction) renderCompactionBody(body, message);
        else renderAssistantBody(body, message);
        followStreamingDisclosures(body, message);
      }
      renderTurnRail();
      if (shouldFollow) scrollBottom();
    });
  }

  function renderMessages({ follow = isNearBottom(), immediate = false } = {}) {
    const previousTop = messagesEl.scrollTop;
    messagesEl.replaceChildren();
    if (!state.messages.length) renderEmpty(messagesEl, submitText);
    state.messages.forEach((message, index) => {
      const row = document.createElement('article');
      row.className = `ai-message ai-message--${message.role}${message.tone ? ` is-${message.tone}` : ''}`;
      row.dataset.messageIndex = String(index);
      if (message.role === 'notice') {
        row.textContent = message.content;
      } else {
        const stack = document.createElement('div');
        stack.className = 'ai-message-stack';
        if (message.role === 'user' && state.editingIndex === index) {
          stack.classList.add('is-editing');
          renderUserEditor(stack, message, index);
          row.append(stack);
          messagesEl.append(row);
          return;
        }
        const body = document.createElement('div');
        body.className = 'ai-message-body';
        if (message.role === 'assistant') {
          if (message.compaction) renderCompactionBody(body, message);
          else renderAssistantBody(body, message);
        }
        else {
          const content = document.createElement('div');
          content.className = 'ai-message-content ai-markdown';
          renderMarkdownInto(content, message.content, markdownRenderOptions(message));
          body.append(content);
          if (message.contextAttachments?.length || message.fileAttachments?.length) {
            body.append(renderSentAttachments(message.contextAttachments || [], message.fileAttachments || []));
          }
        }
        stack.append(body);
        if (!message.compaction) stack.append(createMessageActions(message, index));
        row.append(stack);
      }
      messagesEl.append(row);
    });
    state.followOutput = follow;
    renderTurnRail();
    if (follow) scrollBottom(immediate);
    else messagesEl.scrollTop = previousTop;
  }

  function renderAssistantBody(body, message) {
    const blocks = messageBlocks(message);
    const active = tasks.get(activeConversation(conversationState).id)?.message === message;
    const expected = [];
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (block.type === 'text') {
        const key = `text-${index}`;
        let content = body.querySelector(`[data-ai-block="${key}"]`);
        if (!content) {
          content = document.createElement('div');
          content.className = 'ai-message-content ai-markdown ai-answer-block';
          content.dataset.aiBlock = key;
        }
        renderMarkdownInto(content, block.content, markdownRenderOptions(message));
        expected.push(content);
      } else if (block.type === 'reasoning' || block.type === 'tool') {
        const start = index;
        const activity = [block];
        while (shouldJoinActivityBlock(activity.at(-1), blocks[index + 1])) activity.push(blocks[++index]);
        const groupActive = isActivityGroupActive(activity, {
          messageActive: active,
          isTail: index === blocks.length - 1,
        });
        const key = `activity-${start}`;
        const signature = activityGroupSignature(activity, groupActive);
        let process = body.querySelector(`[data-ai-block="${key}"]`);
        if (!process || process.dataset.signature !== signature) {
          const replacement = renderActivityGroup(activity, groupActive, message);
          replacement.dataset.aiBlock = key;
          replacement.dataset.signature = signature;
          process?.replaceWith(replacement);
          process = replacement;
        } else {
          updateActivityReasoning(process, activity, message);
        }
        expected.push(process);
      }
    }
    if (message.sources?.length) {
      const key = 'sources';
      const signature = message.sources.map((source) => `${source.citation}:${source.url}`).join('|');
      let sources = body.querySelector(`[data-ai-block="${key}"]`);
      if (!sources || sources.dataset.signature !== signature) {
        const replacement = renderSources(message.sources);
        replacement.dataset.aiBlock = key;
        replacement.dataset.signature = signature;
        sources?.replaceWith(replacement);
        sources = replacement;
      }
      expected.push(sources);
    }
    if (active && !message.content && !blocks.some((block) => block.type === 'reasoning' || block.type === 'tool')) {
      let waiting = body.querySelector('[data-ai-block="waiting"]');
      if (!waiting) {
        waiting = document.createElement('div');
        waiting.dataset.aiBlock = 'waiting';
        waiting.className = 'ai-waiting';
        waiting.innerHTML = `<span></span><span></span><span></span><small>正在准备回答</small>`;
      }
      expected.push(waiting);
    }
    const keep = new Set(expected);
    for (const node of body.querySelectorAll(':scope > [data-ai-block]')) if (!keep.has(node)) node.remove();
    expected.forEach((node, index) => {
      const current = body.children[index];
      if (current !== node) body.insertBefore(node, current || null);
    });
  }

  function renderCompactionBody(body, message) {
    let section = body.querySelector('[data-compaction]');
    if (!section) {
      section = document.createElement('section');
      section.className = 'ai-compaction';
      section.dataset.compaction = '';
      const divider = document.createElement('div');
      divider.className = 'ai-compaction-divider';
      divider.innerHTML = '<span></span><small>上下文分隔线</small><span></span>';
      const details = document.createElement('details');
      details.className = 'ai-compaction-box';
      const summary = document.createElement('summary');
      summary.className = 'ai-compaction-summary';
      const content = document.createElement('div');
      content.className = 'ai-compaction-content ai-markdown';
      content.dataset.compactionContent = '';
      details.append(summary, content);
      section.append(divider, details);
      body.append(section);
    }
    const details = section.querySelector('.ai-compaction-box');
    const summary = section.querySelector('.ai-compaction-summary');
    const content = section.querySelector('[data-compaction-content]');
    const status = message.compactionStatus || (message.content ? 'done' : 'running');
    const active = status === 'running';
    const failed = status === 'error';
    details.classList.toggle('is-running', active);
    details.classList.toggle('is-error', failed);
    details.open = active || failed;
    summary.innerHTML = `<span class="ai-compaction-state">${active ? spinnerIcon() : failed ? alertIcon() : activityIcon()}</span><span>${active ? '正在压缩上下文' : failed ? '上下文压缩失败' : '上下文压缩完成'}</span><small>${active ? '生成摘要中' : failed ? '未完成' : '已折叠'}</small>${chevronIcon()}`;
    const displayContent = stripCompactionEnvelope(message.content || '');
    if (displayContent) renderMarkdownInto(content, displayContent, markdownRenderOptions(message));
    else content.innerHTML = active ? '<span class="ai-compaction-placeholder">正在生成压缩摘要…</span>' : '';
  }

  function stripCompactionEnvelope(value) {
    return String(value || '').replace(/^\s*<summary>\s*/i, '').replace(/\s*<\/summary>\s*$/i, '').trim();
  }

  function createMessageActions(message, index) {
    const actions = document.createElement('div');
    actions.className = 'ai-message-actions';
    const copyLabel = message.role === 'user' ? '复制输入' : '复制正文';
    const copy = button('ai-message-action', '', copyLabel);
    copy.setAttribute('aria-label', copyLabel);
    copy.innerHTML = copyIcon();
    copy.addEventListener('click', async () => {
      await copyToClipboard(message.content || '');
      toast('已复制正文');
    });
    actions.append(copy);
    if (message.role === 'user') {
      const edit = button('ai-message-action', '', '修改输入');
      edit.setAttribute('aria-label', '修改输入');
      edit.innerHTML = editIcon();
      edit.addEventListener('click', () => {
        if (tasks.has(activeConversation(conversationState).id)) return;
        state.editingIndex = index;
        renderMessages({ follow: false });
      });
      actions.append(edit);
    } else if (message.role === 'assistant' && !message.compaction) {
      const addToNotes = button('ai-message-action ai-message-action--note', '', '添加到笔记');
      addToNotes.setAttribute('aria-label', '添加到笔记');
      addToNotes.innerHTML = noteAddIcon();
      addToNotes.addEventListener('click', () => {
        const activeTask = tasks.get(activeConversation(conversationState).id);
        if (activeTask?.message === message) { toast('请等待回答生成完成'); return; }
        const note = noteFromAssistantMessage(message);
        if (!note) { toast('回答正文为空，无法添加', { type: 'error' }); return; }
        if (!ctx.persistNotes) { toast('当前项目无法保存笔记', { type: 'error' }); return; }
        ctx.persistNotes(upsertNote(ctx.getNotes?.() || [], note, ctx.graph?.getTags?.() || []));
        ctx.revealSidebarNote?.(note.id);
        toast('已添加到游离笔记');
      });
      actions.append(addToNotes);
      const debug = button('ai-message-action', '', '复制全部调试内容');
      debug.setAttribute('aria-label', '复制全部调试内容');
      debug.innerHTML = debugCopyIcon();
      debug.addEventListener('click', async () => {
        await copyToClipboard(serializeMessageDebug(message, { index }));
        toast('已复制全部调试内容');
      });
      actions.append(debug);
      const regenerate = button('ai-message-action', '', '重新生成回答');
      regenerate.setAttribute('aria-label', '重新生成回答');
      regenerate.innerHTML = regenerateIcon();
      regenerate.addEventListener('click', async () => {
        if (tasks.has(activeConversation(conversationState).id)) return;
        const userIndex = findPreviousUserIndex(index);
        if (userIndex < 0) return;
        if (state.messages.slice(index + 1).some((item) => item.role === 'user' || item.role === 'assistant')
          && !await confirmDialog({ title: '重新生成回答？', message: '这会移除该回答之后的对话。', okText: '重新生成', danger: true })) return;
        await startTurn(state.messages[userIndex].content, { regenerateIndex: index });
      });
      actions.append(regenerate);
    }
    if (message.role === 'assistant' && message.model) {
      const model = document.createElement('span');
      model.className = 'ai-message-model';
      model.textContent = message.model;
      model.title = `由 ${message.model} 生成`;
      actions.append(model);
    }
    return actions;
  }

  function renderUserEditor(stack, message, index) {
    const editor = document.createElement('div');
    editor.className = 'ai-user-editor';
    const textarea = document.createElement('textarea');
    textarea.value = message.content;
    textarea.rows = 2;
    textarea.setAttribute('aria-label', '修改输入内容');
    const controls = document.createElement('div');
    controls.className = 'ai-user-editor-actions';
    const cancel = button('ai-user-edit-cancel', '取消', '取消修改');
    const submitEdit = button('ai-user-edit-submit', '发送', '发送修改后的输入');
    const closeEditor = () => {
      state.editingIndex = -1;
      renderMessages({ follow: false });
    };
    const sendEdit = async () => {
      const text = textarea.value.trim();
      if (!text || tasks.has(activeConversation(conversationState).id)) return;
      state.editingIndex = -1;
      await startTurn(text, { editUserIndex: index });
    };
    cancel.addEventListener('click', closeEditor);
    submitEdit.addEventListener('click', sendEdit);
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); closeEditor(); }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); sendEdit(); }
    });
    controls.append(cancel, submitEdit);
    editor.append(textarea, controls);
    stack.append(editor);
    requestAnimationFrame(() => {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(220, textarea.scrollHeight)}px`;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(220, textarea.scrollHeight)}px`;
    });
  }

  function renderActivityGroup(activity, active, message) {
    const process = document.createElement('details');
    process.className = `ai-process${active ? ' is-active' : ''}`;
    process.open = active;
    const events = activity.filter((block) => block.type === 'tool');
    const executing = events.some((event) => event.status === 'queued' || event.status === 'running');
    const failed = events.some((event) => event.status === 'error');
    const summary = document.createElement('summary');
    const summaryLabel = executing
      ? `正在执行 ${events.length} 个工具步骤`
      : active ? '正在分析'
      : failed ? '工具执行有错误'
        : events.length ? `${events.length} 个工具步骤` : '分析';
    summary.innerHTML = `<span class="ai-process-state">${executing || active ? spinnerIcon() : failed ? alertIcon() : activityIcon()}</span><span>${summaryLabel}</span>${chevronIcon()}`;
    const timeline = document.createElement('div');
    timeline.className = 'ai-process-timeline';
    for (const entry of activityTimelineEntries(activity)) {
      if (entry.block.type === 'reasoning') {
        const analysis = document.createElement('section');
        analysis.className = 'ai-process-analysis';
        analysis.dataset.activityIndex = String(entry.index);
        analysis.innerHTML = `<div class="ai-process-analysis-label">${activityIcon()}<span>分析过程</span></div><div class="ai-process-analysis-content ai-markdown"></div>`;
        timeline.append(analysis);
      } else if (entry.block.name === 'web_search') {
        timeline.append(renderWebSearches([entry.block]));
      } else {
        timeline.append(renderToolEvent(entry.block));
      }
    }
    process.append(summary, timeline);
    updateActivityReasoning(process, activity, message);
    return process;
  }

  function updateActivityReasoning(process, activity, message) {
    for (const analysis of process.querySelectorAll('.ai-process-analysis[data-activity-index]')) {
      const block = activity[Number(analysis.dataset.activityIndex)];
      if (block?.type !== 'reasoning') continue;
      const content = analysis.querySelector('.ai-process-analysis-content');
      if (content.dataset.source === block.content) continue;
      content.dataset.source = block.content;
      renderMarkdownInto(content, block.content, markdownRenderOptions(message));
    }
  }

  function followStreamingDisclosures(body, message) {
    const task = tasks.get(activeConversation(conversationState).id);
    const streaming = task?.message === message || (message.compaction && message.compactionStatus === 'running');
    if (!streaming) return;
    body.querySelectorAll('.ai-reasoning-content, .ai-process-analysis-content, .ai-tool--running > pre, .ai-compaction-box.is-running .ai-compaction-content').forEach((content) => {
      content.scrollTop = content.scrollHeight;
    });
  }

  function renderWebSearches(events) {
    const section = document.createElement('details');
    section.className = `ai-process-step ai-web-search${events.some((event) => event.status === 'running') ? ' is-running' : ''}`;
    section.open = events.some((event) => event.status === 'running');
    const results = uniqueWebResults(events.flatMap((event) => event.result?.results || []));
    const running = events.some((event) => event.status === 'running');
    const queued = events.every((event) => event.status === 'queued');
    const failed = events.some((event) => event.status === 'error');
    const noNew = events.some((event) => event.result?.no_new_results);
    const reused = events.reduce((total, event) => total + (event.result?.search_progress?.repeated_sources || 0), 0);
    const head = document.createElement('summary');
    head.className = 'ai-web-search-head';
    head.innerHTML = `${globeIcon()}<span>${running ? '正在搜索网页' : queued ? '等待搜索网页' : '搜索网页'}</span><small>${results.length ? `${results.length} 个新来源` : failed ? '失败' : running ? '检索中' : queued ? '等待执行' : noNew || reused ? '无新增来源' : '无结果'}</small>${chevronIcon()}`;
    section.append(head);
    if (running && !results.length) {
      const searching = document.createElement('div');
      searching.className = 'ai-searching';
      searching.innerHTML = '<span></span><span></span><span></span><small>正在检索和筛选来源</small>';
      section.append(searching);
    }
    if (results.length) {
      const list = document.createElement('div');
      list.className = 'ai-web-results';
      for (const result of results) {
        const link = document.createElement('a');
        link.href = result.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.append(createSiteIcon(result.url));
        const title = document.createElement('span');
        title.textContent = result.title || hostname(result.url);
        const meta = document.createElement('small');
        meta.textContent = `${displayCitation(result.citation)} ${hostname(result.url)}`.trim();
        const hover = createResultHover(result);
        link.append(title, meta);
        attachFloatingHover(link, hover);
        list.append(link);
      }
      section.append(list);
    }
    return section;
  }

  function renderToolEvent(event) {
    const details = document.createElement('details');
    const outcome = event.result?.status === 'not_found' ? 'not-found' : event.status;
    details.className = `ai-process-step ai-tool ai-tool--${outcome}`;
    details.open = event.status === 'running';
    const summary = document.createElement('summary');
    summary.innerHTML = `<span class="ai-tool-state">${event.status === 'running' ? spinnerIcon() : event.status === 'error' ? alertIcon() : toolIconFor(event.name)}</span><span>${escapeHtml(toolLabel(event.name))}</span><small>${statusLabel(outcome)}</small>${chevronIcon()}`;
    const pre = document.createElement('pre');
    pre.textContent = event.error || summarizeTool(event);
    details.append(summary, pre);
    return details;
  }

  function renderSources(sources) {
    const details = document.createElement('details');
    details.className = 'ai-sources';
    const summary = document.createElement('summary');
    summary.innerHTML = `${linkIcon()}<span>${sources.length} 个引用来源</span>${chevronIcon()}`;
    const list = document.createElement('div');
    for (const source of sources) {
      const link = document.createElement('a');
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.append(createSiteIcon(source.url));
      const citation = document.createElement('span');
      citation.textContent = displayCitation(source.citation);
      const info = document.createElement('div');
      info.innerHTML = `<strong>${escapeHtml(source.title || source.url)}</strong><small>${escapeHtml(source.provider || hostname(source.url))}</small>`;
      const hover = createResultHover(source);
      link.append(citation, info);
      attachFloatingHover(link, hover);
      list.append(link);
    }
    details.append(summary, list);
    return details;
  }

  function createResultHover(source) {
    const hover = document.createElement('span');
    hover.className = 'ai-result-hover';
    const title = document.createElement('strong');
    title.textContent = source.title || source.url;
    const meta = document.createElement('small');
    meta.textContent = `${source.provider || 'Web'} · ${hostname(source.url)}`;
    const excerpt = document.createElement('span');
    excerpt.textContent = source.excerpt || '点击打开来源网页';
    hover.append(title, meta, excerpt);
    return hover;
  }

  function attachFloatingHover(anchor, hover) {
    let removeTimer;
    let watchFrame;
    let touchTimer;
    let longPressed = false;
    let suppressClick = false;
    const dismiss = () => hide(true);
    const hide = (immediate = false) => {
      cancelAnimationFrame(watchFrame);
      watchFrame = 0;
      window.removeEventListener('blur', dismiss);
      messagesEl.removeEventListener('scroll', dismiss);
      hover.classList.remove('is-visible');
      clearTimeout(removeTimer);
      if (immediate) hover.remove();
      else removeTimer = setTimeout(() => hover.remove(), 180);
    };
    const clearTouchTimer = () => { clearTimeout(touchTimer); touchTimer = 0; };
    const onPointerDown = (event) => {
      if (event.pointerType !== 'touch') return;
      clearTouchTimer();
      longPressed = false;
      suppressClick = false;
      touchTimer = setTimeout(() => {
        longPressed = true;
        suppressClick = true;
        show();
      }, 480);
    };
    const onPointerUp = (event) => {
      if (event.pointerType !== 'touch') return;
      clearTouchTimer();
      if (longPressed) { event.preventDefault(); event.stopPropagation(); }
    };
    const watchAnchor = () => {
      if (!anchor.isConnected) { hide(true); return; }
      watchFrame = requestAnimationFrame(watchAnchor);
    };
    const show = () => {
      clearTimeout(removeTimer);
      if (hover.parentNode !== document.body) document.body.append(hover);
      const rect = anchor.getBoundingClientRect();
      const popup = hover.getBoundingClientRect();
      const left = Math.max(8, Math.min(innerWidth - popup.width - 8, rect.left));
      const above = rect.top - popup.height - 8;
      hover.style.left = `${Math.round(left)}px`;
      hover.style.top = `${Math.round(above > 8 ? above : rect.bottom + 8)}px`;
      requestAnimationFrame(() => hover.classList.add('is-visible'));
      cancelAnimationFrame(watchFrame);
      watchFrame = requestAnimationFrame(watchAnchor);
      window.addEventListener('blur', dismiss, { once: true });
      messagesEl.addEventListener('scroll', dismiss, { passive: true, once: true });
    };
    anchor.addEventListener('pointerenter', (event) => { if (event.pointerType !== 'touch') show(); });
    anchor.addEventListener('pointerleave', () => { if (!longPressed) hide(); });
    anchor.addEventListener('pointerdown', onPointerDown);
    anchor.addEventListener('pointerup', onPointerUp);
    anchor.addEventListener('pointercancel', clearTouchTimer);
    anchor.addEventListener('focus', show);
    anchor.addEventListener('blur', hide);
    anchor.addEventListener('click', (event) => {
      if (!suppressClick) return;
      event.preventDefault();
      event.stopPropagation();
      suppressClick = false;
    });
  }

  function switchConversation(id) {
    if (!conversationState.conversations.some((conversation) => conversation.id === id)) return;
    const current = activeConversation(conversationState);
    if (current.id !== id && isConversationEmpty(current)) removeConversation(conversationState, current.id);
    conversationState.activeId = id;
    workspace = createBrowserWorkspace(`${projectId}--${id}`);
    syncActiveWorkspaceFiles();
    state.editingIndex = -1;
    closeSubpanel();
    syncConversationUi();
    renderMessages({ follow: true, immediate: true });
    syncBusy();
    persist();
  }

  function syncConversationUi() {
    const conversation = activeConversation(conversationState);
    panel.querySelector('[data-conversation-title]').textContent = conversation.title || '新对话';
    renderAttachments();
    syncModelLabel();
  }

  function renderAttachments() {
    attachmentsEl.replaceChildren();
    for (const attachment of activeConversation(conversationState).contextAttachments || []) {
      const chip = document.createElement('span');
      chip.className = `ai-attachment-chip ai-context-chip is-${attachment.kind}`;
      chip.title = contextAttachmentTitle(attachment);
      chip.innerHTML = `${attachment.kind === 'file-reference' ? fileIcon() : attachment.kind === 'ai-quote' ? quoteIcon() : graphContextIcon()}<span>${escapeHtml(attachment.label || attachment.nodeId || attachment.path)}</span><small>${attachment.kind === 'graph-tag-note' ? '笔记' : attachment.kind === 'graph-tag' ? '标签' : attachment.kind === 'graph-selection' ? '片段' : attachment.kind === 'graph-position' ? '位置' : attachment.kind === 'graph-node' ? '节点' : attachment.kind === 'ai-quote' ? '引用' : '文件'}</small>`;
      const remove = button('ai-attachment-remove', '', `移除 ${attachment.label || '上下文'}`);
      remove.innerHTML = closeIcon();
      remove.addEventListener('click', () => removeContextAttachment(attachment.id));
      chip.append(remove);
      attachmentsEl.append(chip);
    }
    scheduleContextUsageSync();
    for (const attachment of activeConversation(conversationState).attachments || []) {
      const chip = document.createElement('span');
      chip.className = 'ai-attachment-chip';
      chip.title = attachment.path;
      chip.innerHTML = `${fileIcon()}<span>${escapeHtml(attachment.name || attachment.path)}</span><small>${formatBytes(attachment.size)}</small>`;
      const remove = button('ai-attachment-remove', '', `删除 ${attachment.name || attachment.path}`);
      remove.innerHTML = closeIcon();
      remove.addEventListener('click', () => removePendingFile(attachment.path));
      chip.append(remove);
      attachmentsEl.append(chip);
    }
  }

  function renderSentAttachments(contexts, files) {
    const list = document.createElement('div');
    list.className = 'ai-sent-contexts';
    for (const attachment of [...contexts, ...files]) {
      const item = document.createElement('span');
      item.title = contextAttachmentTitle(attachment);
      const isFile = attachment.kind === 'file-reference' || Boolean(attachment.path && !attachment.nodeId);
      item.innerHTML = `${isFile ? fileIcon() : attachment.kind === 'ai-quote' ? quoteIcon() : graphContextIcon()}<span>${escapeHtml(attachment.label || attachment.name || attachment.nodeId || attachment.path)}</span>`;
      list.append(item);
    }
    return list;
  }

  function removePendingFile(path) {
    const conversation = activeConversation(conversationState);
    conversation.attachments = (conversation.attachments || []).filter((attachment) => attachment.path !== path);
    persist();
    renderAttachments();
  }

  function removeContextAttachment(id) {
    const conversation = activeConversation(conversationState);
    conversation.contextAttachments = (conversation.contextAttachments || []).filter((item) => item.id !== id);
    persist();
    renderAttachments();
  }

  function addContextAttachment(attachment) {
    if (!attachment) return false;
    ensureConversationForExternalContext();
    setCollapsed(false, { persist: false });
    const conversation = activeConversation(conversationState);
    conversation.contextAttachments = appendUniqueContext(conversation.contextAttachments, attachment);
    conversation.updatedAt = new Date().toISOString();
    persist();
    renderAttachments();
    input.focus();
    return true;
  }

  function ensureConversationForExternalContext() {
    if (panel.classList.contains('is-open')) return;
    if (!isConversationEmpty(activeConversation(conversationState))) {
      addConversation(conversationState, { modelId: activeConversation(conversationState).modelId || providerState.activeModelId || '' });
      switchConversation(conversationState.activeId);
    }
    setOpen(true);
  }

  function contextAttachmentTitle(attachment) {
    if (attachment.kind === 'graph-tag-note') return `${attachment.label}\n${attachment.content || ''}`;
    if (attachment.kind === 'graph-selection' || attachment.kind === 'graph-tag') return `${attachment.label}\n${attachment.text || ''}`;
    if (attachment.kind === 'ai-quote') return `${attachment.label}\n${attachment.text || ''}`;
    return attachment.label || attachment.name || attachment.nodeId || attachment.path || '上下文';
  }

  function showConversations(force = false) {
    if (!openSubpanel('conversations', 'is-popover is-conversation-popover', !force)) return;
    positionSubpanel(panel.querySelector('[data-conversations]'), 'below');
    subpanel.innerHTML = '<div class="ai-conversation-list"></div>';
    const list = subpanel.querySelector('.ai-conversation-list');
    const conversations = conversationState.conversations.filter((conversation) => !isConversationEmpty(conversation));
    if (!conversations.length) list.innerHTML = '<p class="ai-popover-empty">还没有历史对话</p>';
    for (const conversation of conversations) {
      const row = document.createElement('div');
      row.className = `ai-conversation-item${conversation.id === conversationState.activeId ? ' is-active' : ''}`;
      const select = button('ai-conversation-select', '', conversation.title);
      select.innerHTML = `<strong>${escapeHtml(conversation.title)}</strong><small>${conversation.messages.filter((message) => message.role === 'user').length} 轮 · ${formatConversationTime(conversation.updatedAt)}</small>`;
      select.addEventListener('click', () => switchConversation(conversation.id));
      const rename = button('ai-conversation-action', '', '重命名');
      rename.innerHTML = editIcon();
      rename.addEventListener('click', () => beginConversationRename(row, conversation));
      const remove = button('ai-conversation-action', '', '删除对话');
      remove.innerHTML = trashIcon();
      remove.addEventListener('click', async () => {
        if (conversation.messages.length && !await confirmDialog({ title: '删除对话？', message: `删除“${conversation.title}”及其本地工作区文件。`, okText: '删除', danger: true })) return;
        tasks.get(conversation.id)?.aborter.abort();
        tasks.delete(conversation.id);
        const removedWorkspace = createBrowserWorkspace(`${projectId}--${conversation.id}`);
        removeConversation(conversationState, conversation.id);
        workspace = createBrowserWorkspace(`${projectId}--${activeConversation(conversationState).id}`);
        try { await removedWorkspace.clear(); } catch (error) { console.warn('failed to remove conversation files', error); }
        persist();
        syncConversationUi();
        showConversations(true);
        renderMessages({ follow: true, immediate: true });
      });
      row.append(select, rename, remove);
      list.append(row);
    }
  }

  function beginConversationRename(row, conversation) {
    const editor = document.createElement('div');
    editor.className = 'ai-conversation-rename';
    const field = document.createElement('input');
    field.value = conversation.title;
    field.maxLength = 64;
    const cancel = button('', '取消', '取消');
    const save = button('is-primary', '保存', '保存标题');
    const commit = () => {
      if (!renameConversation(conversation, field.value)) return;
      persist();
      syncConversationUi();
      showConversations(true);
    };
    cancel.addEventListener('click', () => showConversations(true));
    save.addEventListener('click', commit);
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') commit();
      if (event.key === 'Escape') showConversations(true);
    });
    editor.append(field, cancel, save);
    row.replaceChildren(editor);
    field.focus();
    field.select();
  }

  function renderTurnRail() {
    const turns = [];
    for (let index = 0; index < state.messages.length; index += 1) {
      if (state.messages[index].role !== 'user') continue;
      const nextUser = state.messages.findIndex((message, at) => at > index && message.role === 'user');
      const end = nextUser < 0 ? state.messages.length : nextUser;
      const answer = state.messages.slice(index + 1, end).find((message) => message.role === 'assistant');
      turns.push({ index, user: state.messages[index], answer });
    }
    turnRail.hidden = !turns.length;
    const signature = turns.map((turn) => turn.index).join('|');
    if (turnRail.dataset.signature === signature) {
      [...turnRail.querySelectorAll('.ai-turn-marker')].forEach((marker, order) => {
        const turn = turns[order];
        marker.querySelector('.ai-turn-preview strong').textContent = truncateText(turn.user.content, 82);
        marker.querySelector('.ai-turn-preview > span').textContent = truncateText(turn.answer?.content || '正在生成回答…', 150);
      });
      syncActiveTurn();
      return;
    }
    turnRail.dataset.signature = signature;
    turnRail.replaceChildren();
    turns.forEach((turn, order) => {
      const marker = button('ai-turn-marker', '', '');
      marker.removeAttribute('title');
      marker.setAttribute('aria-label', `第 ${order + 1} 轮对话`);
      marker.dataset.targetIndex = String(turn.index);
      const line = document.createElement('span');
      line.className = 'ai-turn-line';
      const preview = document.createElement('span');
      preview.className = 'ai-turn-preview';
      preview.innerHTML = `<strong>${escapeHtml(truncateText(turn.user.content, 82))}</strong><span>${escapeHtml(truncateText(turn.answer?.content || '正在生成回答…', 150))}</span>`;
      marker.append(line, preview);
      marker.addEventListener('click', () => {
        stopFollowing();
        messagesEl.querySelector(`[data-message-index="${turn.index}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      turnRail.append(marker);
    });
    syncActiveTurn();
  }

  function syncActiveTurn() {
    const markers = [...turnRail.querySelectorAll('.ai-turn-marker')];
    if (!markers.length) return;
    const top = messagesEl.getBoundingClientRect().top + 54;
    let active = markers[0];
    for (const marker of markers) {
      const row = messagesEl.querySelector(`[data-message-index="${marker.dataset.targetIndex}"]`);
      if (row && row.getBoundingClientRect().top <= top) active = marker;
    }
    markers.forEach((marker) => marker.classList.toggle('is-active', marker === active));
  }

  function showSettings(toggle = false) {
    if (!openSubpanel('settings', 'is-popover is-settings-popover', toggle)) return;
    positionSubpanel(panel.querySelector('[data-settings]'), 'below');
    subpanel.innerHTML = `<div class="ai-subpanel-head"><strong>模型设置</strong><button class="icon-btn" data-sub-close>${closeIcon()}</button></div><section class="ai-enabled-models"><div class="ai-settings-section-head"><strong>对话可用模型</strong></div><div data-enabled-models></div></section><section class="ai-provider-section"><div class="ai-settings-section-head"><strong>模型提供商</strong></div><div class="ai-provider-list" data-provider-list></div><button class="ai-add-provider" data-add-provider>${plusIcon()}<span>添加模型提供商</span></button></section>`;
    subpanel.querySelector('[data-sub-close]').addEventListener('click', closeSubpanel);
    subpanel.querySelector('[data-add-provider]').addEventListener('click', () => showProviderEditor());
    renderProviderSettings();
  }

  function renderProviderSettings() {
    const enabled = subpanel.querySelector('[data-enabled-models]');
    const providers = subpanel.querySelector('[data-provider-list]');
    if (!enabled || !providers) return;
    enabled.replaceChildren();
    if (!providerState.enabledModels.length) enabled.innerHTML = '<p class="ai-settings-empty">尚未添加可用模型</p>';
    for (const model of providerState.enabledModels) {
      const row = document.createElement('div');
      row.className = 'ai-enabled-model';
      const name = document.createElement('strong');
      name.textContent = model.displayName;
      name.title = model.displayName;
      const remove = button('icon-btn', '', '从可用模型中移除');
      remove.innerHTML = closeIcon();
      remove.addEventListener('click', () => { disableModel(providerState, model.id); persistProviders(); renderProviderSettings(); syncModelLabel(); });
      const rename = button('icon-btn', '', '自定义模型名称');
      rename.innerHTML = editIcon();
      rename.addEventListener('click', () => beginModelRename(row, model));
      row.append(name, rename, remove);
      enabled.append(row);
    }
    providers.replaceChildren();
    for (const provider of providerState.providers) {
      const card = document.createElement('article');
      card.className = 'ai-provider';
      card.dataset.providerId = provider.id;
      const expanded = expandedProviders.has(provider.id);
      card.innerHTML = `<div class="ai-provider-head"><strong>${escapeHtml(provider.name)}</strong><span class="ai-runtime-badge is-${provider.runtime || 'local'}">${provider.runtime === 'server' ? '云端' : '本地'}</span><span class="ai-provider-status is-${escapeAttr(provider.status)}"><i></i>${provider.status === 'ok' ? '可用' : provider.status === 'error' ? '不可用' : '未检测'}</span><span class="ai-provider-actions"><button class="icon-btn" data-refresh title="检测并刷新模型">${regenerateIcon()}</button><button class="icon-btn" data-edit title="编辑提供商">${editIcon()}</button><button class="icon-btn" data-remove title="删除提供商">${trashIcon()}</button></span></div><button class="ai-provider-toggle" data-provider-toggle aria-expanded="${expanded}"><span>${provider.modelsCache.length ? `${provider.modelsCache.length} 个可用模型` : '尚未获取模型'}</span>${chevronIcon()}</button><div class="ai-provider-models"${expanded ? '' : ' hidden'}></div>`;
      card.querySelector('[data-refresh]').addEventListener('click', () => refreshProvider(provider, card));
      card.querySelector('[data-edit]').addEventListener('click', () => showProviderEditor(provider));
      card.querySelector('[data-remove]').addEventListener('click', async () => {
        if (!await confirmDialog({ title: '删除服务商？', message: `删除“${provider.name}”及其已启用模型。`, okText: '删除', danger: true })) return;
        if (provider.runtime === 'server' && provider.protocol !== 'server-codex' && sessionSnapshot().user) {
          try { await serverApi.deleteProvider(provider.id); }
          catch (error) { toast(`云端配置删除失败：${error.message}`, { type: 'error' }); return; }
        }
        removeProvider(providerState, provider.id); persistProviders(); renderProviderSettings(); syncModelLabel();
      });
      card.querySelector('[data-provider-toggle]').addEventListener('click', () => {
        if (expandedProviders.has(provider.id)) expandedProviders.delete(provider.id);
        else expandedProviders.add(provider.id);
        renderProviderSettings();
      });
      renderDiscoveredModels(card.querySelector('.ai-provider-models'), provider);
      providers.append(card);
    }
  }

  function beginModelRename(row, model) {
    const editor = document.createElement('div');
    editor.className = 'ai-model-rename';
    const input = document.createElement('input');
    input.value = model.displayName;
    input.maxLength = 64;
    const cancel = button('', '取消', '取消');
    const save = button('is-primary', '保存', '保存自定义名称');
    const commit = () => {
      if (!renameEnabledModel(providerState, model.id, input.value)) return;
      persistProviders(); syncModelLabel(); renderProviderSettings();
    };
    cancel.addEventListener('click', renderProviderSettings);
    save.addEventListener('click', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') commit();
      if (event.key === 'Escape') renderProviderSettings();
    });
    editor.append(input, cancel, save);
    row.replaceChildren(editor);
    input.focus(); input.select();
  }

  function renderDiscoveredModels(container, provider) {
    container.replaceChildren();
    if (!provider.modelsCache.length) {
      container.innerHTML = `<p>${escapeHtml(provider.statusText || '尚未获取模型列表。')}</p>`;
      return;
    }
    for (const modelId of provider.modelsCache) {
      const existing = providerState.enabledModels.find((item) => item.providerId === provider.id && item.modelId === modelId);
      const row = button('ai-discovered-model', '', existing ? `移除 ${modelId}` : `启用 ${modelId}`);
      row.innerHTML = `<span>${escapeHtml(modelId)}</span><small aria-hidden="true">${existing ? checkIcon() : plusIcon()}</small>`;
      row.classList.toggle('is-enabled', Boolean(existing));
      row.addEventListener('click', () => {
        if (existing) disableModel(providerState, existing.id);
        else enableModel(providerState, provider.id, modelId, modelId);
        persistProviders(); renderProviderSettings(); syncModelLabel();
      });
      container.append(row);
    }
  }

  async function refreshProvider(provider, card) {
    const action = card.querySelector('[data-refresh]');
    action.disabled = true;
    action.innerHTML = spinnerIcon();
    action.title = '正在检测模型';
    try {
      const key = sessionStorage.getItem(`${PROVIDER_KEY_SESSION}:${provider.id}`) || '';
      const result = provider.protocol === 'server-codex'
        ? { models: ['codex'], latencyMs: 0 }
        : provider.runtime === 'server'
          ? { ...(await serverApi.discoverServerModels(provider.id)), latencyMs: 0 }
          : await discoverProviderModels(provider, key);
      updateProvider(providerState, provider.id, { modelsCache: result.models, status: 'ok', statusText: `${result.models.length} 个模型 · ${result.latencyMs} ms`, checkedAt: new Date().toISOString() });
      expandedProviders.add(provider.id);
      toast(`已发现 ${result.models.length} 个模型`);
    } catch (error) {
      updateProvider(providerState, provider.id, { status: 'error', statusText: error?.message || String(error), checkedAt: new Date().toISOString() });
    }
    persistProviders(); renderProviderSettings();
  }

  function showProviderEditor(provider = null) {
    const protocol = provider?.protocol || 'openai-chat';
    const baseUrl = provider?.baseUrl || PROVIDER_PROTOCOLS.find((item) => item.id === protocol)?.defaultBaseUrl || '';
    const list = subpanel.querySelector('[data-provider-list]');
    if (!list) return;
    let card = provider ? list.querySelector(`[data-provider-id="${CSS.escape(provider.id)}"]`) : null;
    if (!card) { card = document.createElement('article'); list.append(card); }
    card.className = 'ai-provider is-editing';
    const runtime = provider?.runtime || 'local';
    card.innerHTML = `<div class="ai-inline-provider-head"><strong>${provider ? '编辑提供商' : '新提供商'}</strong></div><label>运行位置<select data-provider-runtime><option value="local"${runtime === 'local' ? ' selected' : ''}>本地 · 浏览器运行</option><option value="server"${runtime === 'server' ? ' selected' : ''}>云端 · 关闭网页后继续</option></select></label><label>名称<input data-provider-name value="${escapeAttr(provider?.name || '')}" placeholder="例如 DeepSeek"></label><label>接口<select data-provider-protocol>${PROVIDER_PROTOCOLS.map((item) => `<option value="${item.id}"${item.id === protocol ? ' selected' : ''}>${item.label}</option>`).join('')}</select></label><label data-base-field>Base URL<input data-provider-base value="${escapeAttr(baseUrl)}"></label><label data-key-field>API Key<input data-provider-key type="password" value="${escapeAttr(provider?.runtime === 'local' ? sessionStorage.getItem(`${PROVIDER_KEY_SESSION}:${provider.id}`) || '' : '')}" placeholder="${runtime === 'server' ? '已加密保存在云端；留空则不修改' : '仅保存在当前会话'}"></label><p class="ai-provider-runtime-note" data-runtime-note></p><div class="ai-provider-editor-actions"><button class="btn" data-cancel>取消</button><button class="btn btn--primary" data-save>保存</button></div>`;
    const protocolSelect = card.querySelector('[data-provider-protocol]');
    const runtimeSelect = card.querySelector('[data-provider-runtime]');
    const syncRuntimeFields = () => {
      const codex = protocolSelect.value === 'server-codex';
      if (codex) runtimeSelect.value = 'server';
      runtimeSelect.disabled = codex;
      card.querySelector('[data-base-field]').hidden = codex;
      card.querySelector('[data-key-field]').hidden = codex;
      card.querySelector('[data-runtime-note]').textContent = codex ? 'Codex 使用服务器唯一实例，只能在云端运行。' : runtimeSelect.value === 'server' ? 'API Key 将进入你的加密服务端工作区。' : '请求和 API Key 均不会发送到 Entail 服务端。';
    };
    protocolSelect.addEventListener('change', () => {
      const item = PROVIDER_PROTOCOLS.find((entry) => entry.id === protocolSelect.value);
      card.querySelector('[data-provider-base]').value = item?.defaultBaseUrl || '';
      syncRuntimeFields();
    });
    runtimeSelect.addEventListener('change', syncRuntimeFields);
    syncRuntimeFields();
    card.querySelector('[data-cancel]').addEventListener('click', renderProviderSettings);
    card.querySelector('[data-save]').addEventListener('click', async () => {
      const input = { name: card.querySelector('[data-provider-name]').value.trim(), protocol: protocolSelect.value, baseUrl: card.querySelector('[data-provider-base]').value.trim(), runtime: runtimeSelect.value };
      const saved = provider ? updateProvider(providerState, provider.id, input) : addProvider(providerState, input);
      const apiKey = card.querySelector('[data-provider-key]').value.trim();
      if (saved.runtime === 'server' && saved.protocol !== 'server-codex') {
        if (!sessionSnapshot().user) { toast('请先登录，再保存云端服务商', { type: 'error' }); return; }
        try { await serverApi.saveProvider(saved.id, { ...saved, apiKey }); }
        catch (error) { toast(error.message, { type: 'error' }); return; }
        sessionStorage.removeItem(`${PROVIDER_KEY_SESSION}:${saved.id}`);
      } else if (saved.runtime === 'local') sessionStorage.setItem(`${PROVIDER_KEY_SESSION}:${saved.id}`, apiKey);
      if (saved.protocol === 'server-codex' && !providerState.enabledModels.some((item) => item.providerId === saved.id)) enableModel(providerState, saved.id, 'codex', 'Codex Cloud');
      expandedProviders.add(saved.id);
      persistProviders(); renderProviderSettings();
    });
    card.querySelector('[data-provider-name]').focus();
    card.scrollIntoView({ block: 'nearest' });
  }

  function showModelPicker() {
    if (!openSubpanel('models', 'is-popover is-model-popover', true)) return;
    positionSubpanel(panel.querySelector('[data-model-label]'), 'above');
    subpanel.innerHTML = `<div class="ai-model-picker"></div><button class="ai-model-settings-link" data-open-settings>管理服务商与模型</button>`;
    subpanel.querySelector('[data-open-settings]').addEventListener('click', showSettings);
    const picker = subpanel.querySelector('.ai-model-picker');
    if (!providerState.enabledModels.length) picker.innerHTML = '<p>尚未启用模型。</p>';
    for (const model of providerState.enabledModels) {
      const row = button('ai-model-picker-item', '', model.displayName);
      const provider = providerState.providers.find((item) => item.id === model.providerId);
      row.innerHTML = `<span><strong>${escapeHtml(model.displayName)}</strong><small>${provider?.runtime === 'server' ? '云端' : '本地'}</small></span>${activeConversation(conversationState).modelId === model.id ? checkIcon() : ''}`;
      row.addEventListener('click', () => { selectConversationModel(model.id); closeSubpanel(); });
      picker.append(row);
    }
  }

  function showContextPanel() {
    if (!openSubpanel('context', 'is-popover is-context-popover', true)) return;
    const snapshot = getContextSnapshot();
    subpanel.innerHTML = `<div class="ai-context-inline" aria-label="上下文使用量"><span class="ai-context-panel-ring" data-context-meter aria-hidden="true"></span><strong data-context-panel-value></strong><small data-context-panel-percent></small><button class="ai-context-compact" data-context-compact title="压缩上下文">压缩</button><button class="icon-btn" data-sub-close title="关闭">${closeIcon()}</button></div>`;
    subpanel.querySelector('[data-sub-close]').addEventListener('click', closeSubpanel);
    subpanel.querySelector('[data-context-compact]').addEventListener('click', async () => {
      const button = subpanel.querySelector('[data-context-compact]');
      button.disabled = true;
      await runConversationCompaction();
      if (!subpanel.hidden) {
        updateContextPanel(getContextSnapshot());
        button.disabled = state.compacting;
      }
    });
    positionSubpanel(contextToggle, 'above');
    updateContextPanel(snapshot);
  }

  function getContextSnapshot() {
    const conversation = activeConversation(conversationState);
    const modelConfig = currentModelConfig();
    const pendingAttachments = [
      ...(conversation.contextAttachments || []),
      ...(conversation.attachments || []).map(graphFileAttachment).filter(Boolean),
    ];
    const history = modelHistory(conversation.messages);
    const system = [DEFAULT_SYSTEM_PROMPT, buildGraphContext(ctx.model, selectedNodeId)].filter(Boolean).join('\n\n');
    const userText = contextPrompt(input.value || '', pendingAttachments, ctx.model);
    const tokens = estimateContextTokens({ system, history, userText, tools: contextToolDefinitions });
    return contextUsage(tokens, resolveContextWindow(modelConfig));
  }

  function syncContextUsage() {
    const snapshot = getContextSnapshot();
    state.contextSnapshot = snapshot;
    contextToggle.style.setProperty('--context-ratio', `${Math.min(1, snapshot.ratio) * 100}%`);
    contextToggle.classList.toggle('is-warning', snapshot.ratio >= 0.8 && snapshot.ratio < 1);
    contextToggle.classList.toggle('is-danger', snapshot.ratio >= 1);
    contextToggle.title = `上下文 ${formatTokenCount(snapshot.tokens)} / ${formatTokenCount(snapshot.total)}（发送前估算）`;
    updateContextPanel(snapshot);
  }

  function scheduleContextUsageSync() {
    cancelAnimationFrame(state.contextEstimateFrame);
    state.contextEstimateFrame = requestAnimationFrame(() => {
      state.contextEstimateFrame = 0;
      syncContextUsage();
    });
  }

  function updateContextPanel(snapshot) {
    if (subpanel.hidden || subpanel.dataset.mode !== 'context') return;
    const meter = subpanel.querySelector('[data-context-meter]');
    if (meter) meter.style.setProperty('--context-ratio', `${Math.min(1, snapshot.ratio) * 100}%`);
    const value = subpanel.querySelector('[data-context-panel-value]');
    const percent = subpanel.querySelector('[data-context-panel-percent]');
    if (value) value.textContent = `${formatTokenCount(snapshot.tokens)} / ${formatTokenCount(snapshot.total)}`;
    if (percent) percent.textContent = `${snapshot.percent}%`;
    const compact = subpanel.querySelector('[data-context-compact]');
    if (compact) compact.disabled = state.compacting || tasks.has(activeConversation(conversationState).id) || !activeConversation(conversationState).messages.some((message) => message.role === 'user' || message.role === 'assistant');
  }

  function setContextPanelStatus(message) {
    const status = subpanel.querySelector('[data-context-status]');
    if (status) status.textContent = message;
  }

  function selectConversationModel(id) {
    const model = providerState.enabledModels.find((item) => item.id === id);
    if (!model) return;
    activeConversation(conversationState).modelId = id;
    providerState.activeModelId = id;
    persist(); persistProviders(); syncModelLabel();
    if (!subpanel.hidden && subpanel.querySelector('[data-enabled-models]')) renderProviderSettings();
  }

  async function showWorkspace(toggle = false) {
    if (!openSubpanel('files', 'is-popover is-files-popover', toggle)) return;
    positionSubpanel(panel.querySelector('[data-workspace]'), 'below');
    subpanel.innerHTML = `<div class="ai-subpanel-head"><div><strong>当前对话文件</strong><small data-file-count>正在读取…</small></div><button class="icon-btn" data-sub-close>${closeIcon()}</button></div><p>正在读取…</p>`;
    subpanel.querySelector('[data-sub-close]').addEventListener('click', closeSubpanel);
    try {
      const files = await workspace.listFiles();
      const count = subpanel.querySelector('[data-file-count]');
      if (count) count.textContent = files.length ? `${files.length} 个工作区文件` : '工作区为空';
      const list = document.createElement('div');
      list.className = 'ai-workspace-list';
      if (!files.length) list.innerHTML = '<p class="ai-workspace-empty">当前对话还没有文件。点击输入框旁的回形针添加文件或 PDF。</p>';
      for (const file of files) {
        const row = document.createElement('div');
        const folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '工作区根目录';
        row.title = file.path;
        row.innerHTML = `<span class="ai-workspace-file-icon">${fileIcon()}</span><span class="ai-workspace-file-meta"><strong>${escapeHtml(file.name || file.path.split('/').pop())}</strong><small>${escapeHtml(folder)} · ${formatBytes(file.size)}</small></span>`;
        const remove = button('ai-file-remove', '', `删除 ${file.path}`);
        remove.innerHTML = trashIcon();
        remove.addEventListener('click', () => deleteConversationFile(file.path, { refreshFiles: true }));
        row.append(remove);
        list.append(row);
      }
      subpanel.querySelector('p')?.replaceWith(list);
    } catch (error) {
      const p = subpanel.querySelector('p');
      if (p) p.textContent = error?.message || String(error);
    }
  }

  async function deleteConversationFile(path, { refreshFiles = false } = {}) {
    try {
      await workspace.deleteFile(path);
      const conversation = activeConversation(conversationState);
      if (sessionSnapshot().user) {
        try { await serverApi.deleteFile(`${projectId}--${conversation.id}`, path); }
        catch (error) { if (error.status !== 404) throw error; }
      }
      conversation.attachments = (conversation.attachments || []).filter((attachment) => attachment.path !== path);
      persist();
      renderAttachments();
      if (refreshFiles || subpanel.dataset.mode === 'files') await showWorkspace();
    } catch (error) {
      toast(`删除失败：${error?.message || error}`);
    }
  }

  function openSubpanel(mode, classNames, toggle = false) {
    if (toggle && !subpanel.hidden && subpanel.dataset.mode === mode) { closeSubpanel(); return false; }
    subpanel.removeAttribute('style');
    subpanel.className = `ai-subpanel ${classNames}`;
    subpanel.dataset.mode = mode;
    subpanel.hidden = false;
    panel.querySelector('[data-conversations]').setAttribute('aria-expanded', mode === 'conversations' ? 'true' : 'false');
    panel.querySelector('[data-model-label]').setAttribute('aria-expanded', mode === 'models' ? 'true' : 'false');
    contextToggle.setAttribute('aria-expanded', mode === 'context' ? 'true' : 'false');
    return true;
  }
  function closeSubpanel() {
    subpanel.hidden = true;
    subpanel.replaceChildren();
    subpanel.className = 'ai-subpanel';
    subpanel.removeAttribute('style');
    delete subpanel.dataset.mode;
    panel.querySelector('[data-conversations]').setAttribute('aria-expanded', 'false');
    panel.querySelector('[data-model-label]').setAttribute('aria-expanded', 'false');
    contextToggle.setAttribute('aria-expanded', 'false');
  }
  function positionSubpanel(anchor, placement) {
    const panelRect = panel.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const width = Math.min(340, panelRect.width - 24);
    const left = Math.max(10, Math.min(panelRect.width - width - 10, anchorRect.left - panelRect.left));
    subpanel.style.width = `${Math.round(width)}px`;
    subpanel.style.left = `${Math.round(left)}px`;
    if (placement === 'above') {
      subpanel.style.bottom = `${Math.round(panelRect.bottom - anchorRect.top + 7)}px`;
      subpanel.style.top = 'auto';
    } else {
      subpanel.style.top = `${Math.round(anchorRect.bottom - panelRect.top + 7)}px`;
      subpanel.style.bottom = 'auto';
    }
  }
  function showLayoutPicker() {
    if (!openSubpanel('layout', 'is-popover is-layout-popover', true)) return;
    positionSubpanel(panel.querySelector('[data-layout]'), 'below');
    const modes = [
      ['floating', '悬浮', '覆盖在工作区上，可手动折叠'],
      ['docked', '占位', '将图谱或详情区域向左收窄'],
    ];
    subpanel.innerHTML = `<div class="ai-layout-picker">${modes.map(([id, title, detail]) => `<button data-layout-mode="${id}"${panel.dataset.layout === id ? ' class="is-active"' : ''}><span>${layoutModeIcon(id)}</span><div><strong>${title}</strong><small>${detail}</small></div>${panel.dataset.layout === id ? checkIcon() : ''}</button>`).join('')}</div>`;
    subpanel.querySelectorAll('[data-layout-mode]').forEach((item) => item.addEventListener('click', () => {
      setLayout(item.dataset.layoutMode);
      closeSubpanel();
    }));
  }

  async function updateMentionMenu() {
    const mention = mentionQueryAt(input.value, input.selectionStart);
    state.mention = mention;
    if (!mention) { closeMentionMenu(); return; }
    const request = ++state.mentionRequest;
    mentionMenu.hidden = false;
    mentionMenu.innerHTML = `<div class="ai-mention-searching">${spinnerIcon()}<span>搜索图谱节点与文件…</span></div>`;
    let files = [];
    try { files = await workspace.listFiles(); } catch { files = activeConversation(conversationState).attachments || []; }
    if (request !== state.mentionRequest || !state.mention) return;
    state.mentionItems = searchMentionCandidates(ctx.model, files, mention.query);
    state.mentionIndex = 0;
    renderMentionMenu();
  }

  function renderMentionMenu() {
    mentionMenu.hidden = false;
    if (!state.mentionItems.length) {
      mentionMenu.innerHTML = '<div class="ai-mention-empty">没有匹配的节点或文件，继续输入以搜索</div>';
      return;
    }
    mentionMenu.innerHTML = state.mentionItems.map((item, index) => `<button data-mention-index="${index}" class="${index === state.mentionIndex ? 'is-active' : ''}"><span class="ai-mention-kind">${item.kind === 'node' ? graphContextIcon() : fileIcon()}</span><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small></div><em>${item.kind === 'node' ? '节点' : '文件'}</em></button>`).join('');
    mentionMenu.querySelectorAll('[data-mention-index]').forEach((item) => {
      item.addEventListener('mousedown', (event) => event.preventDefault());
      item.addEventListener('click', () => selectMention(Number(item.dataset.mentionIndex)));
    });
  }

  function handleMentionKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); closeMentionMenu(); return true; }
    if (!state.mentionItems.length) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      state.mentionIndex = (state.mentionIndex + delta + state.mentionItems.length) % state.mentionItems.length;
      renderMentionMenu();
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      selectMention(state.mentionIndex);
      return true;
    }
    return false;
  }

  function selectMention(index) {
    const item = state.mentionItems[index];
    if (!item || !state.mention) return;
    const attachment = item.kind === 'node' ? graphNodeAttachment(ctx.model, item.node.id) : graphFileAttachment(item.file);
    const replacement = replaceMention(input.value, state.mention, item.label);
    input.value = replacement.value;
    addContextAttachment(attachment);
    closeMentionMenu();
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(replacement.caret, replacement.caret);
    });
  }

  function closeMentionMenu() {
    state.mention = null;
    state.mentionItems = [];
    state.mentionRequest += 1;
    mentionMenu.hidden = true;
    mentionMenu.replaceChildren();
  }
  function markdownRenderOptions(message) {
    return {
      macros: ctx.model?.meta?.macros,
      sources: message.sources || [],
      graphLabels: ctx.model?.labelIndex,
      onGraphHover: (anchor, node, label) => {
        if (!node || !label) return;
        ctx.refLayer?.showLabelPreview(anchor, node, label);
      },
      onGraphLeave: () => ctx.refLayer?.scheduleLabelPreviewClose(),
      onGraphNavigate: (node, label) => {
        if (!node) return;
        ctx.refLayer?.closePreviews();
        selectedNodeId = node.id;
        navigateGraphReference(ctx, node, label);
      },
      onGraphReference: (reference) => {
        const tags = ctx.graph?.getTags?.() || [];
        const notes = ctx.getNotes?.() || [];
        const resolvedNote = resolveTagNoteReference(reference, tags, notes);
        if (resolvedNote) { ctx.openNoteEditor?.(resolvedNote.note.id); return; }
        const member = graphReferenceToMember(reference, tags, notes);
        if (member) ctx.jumpToMember?.(member);
      },
    };
  }
  function persist() {
    const conversation = activeConversation(conversationState);
    persistConversation(conversation);
  }
  function persistConversation(conversation) {
    if (conversationState.conversations.includes(conversation)) conversation.updatedAt = new Date().toISOString();
    saveConversationState(localStorage, conversationsKey, conversationState);
    clearTimeout(state.cloudConversationTimer);
    state.cloudConversationTimer = setTimeout(() => saveCloudConversations(projectId, conversationState), 650);
  }
  function syncActiveWorkspaceFiles() {
    if (!sessionSnapshot().user) return;
    const conversation = activeConversation(conversationState);
    syncWorkspaceFiles(workspace, `${projectId}--${conversation.id}`).catch((error) => console.warn('failed to sync AI workspace files', error));
  }
  function isNearBottom() { return isScrollNearBottom(messagesEl, 56); }
  function stopFollowing() {
    state.followOutput = false;
    if (state.scrollFrame) cancelAnimationFrame(state.scrollFrame);
    state.scrollFrame = 0;
  }
  function scrollBottom(immediate = false) {
    if (!state.followOutput) return;
    state.scrollTarget = messagesEl.scrollHeight;
    if (immediate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      messagesEl.scrollTop = state.scrollTarget;
      return;
    }
    if (state.scrollFrame) return;
    const tick = () => {
      if (!state.followOutput) { state.scrollFrame = 0; return; }
      state.scrollTarget = messagesEl.scrollHeight;
      const distance = state.scrollTarget - messagesEl.scrollTop - messagesEl.clientHeight;
      if (Math.abs(distance) < 1) {
        messagesEl.scrollTop = state.scrollTarget;
        state.scrollFrame = 0;
        return;
      }
      messagesEl.scrollTop += distance * 0.16;
      state.scrollFrame = requestAnimationFrame(tick);
    };
    state.scrollFrame = requestAnimationFrame(tick);
  }
  function findPreviousUserIndex(from) {
    for (let index = from - 1; index >= 0; index -= 1) if (state.messages[index]?.role === 'user') return index;
    return -1;
  }
  function modelHistory(messages) {
    const eligible = messages.filter((message) => message.role === 'user' || message.role === 'assistant');
    const separatorIndex = eligible.findLastIndex((message) => message.compaction && message.compactionStatus === 'done');
    const activeMessages = separatorIndex >= 0 ? eligible.slice(separatorIndex) : eligible;
    return activeMessages.map((message) => ({
      ...message,
      content: message.role === 'user'
        ? contextPrompt(message.content, [
          ...(message.contextAttachments || []),
          ...(message.fileAttachments || []).map(graphFileAttachment).filter(Boolean),
        ], ctx.model)
        : message.content,
    }));
  }
  function currentModelConfig() {
    const conversation = activeConversation(conversationState);
    return resolveModelConfig(providerState, conversation.modelId || providerState.activeModelId, sessionStorage, PROVIDER_KEY_SESSION);
  }
  function persistProviders() {
    saveProviderState(localStorage, PROVIDERS_KEY, providerState);
    clearTimeout(state.cloudProviderTimer);
    state.cloudProviderTimer = setTimeout(() => saveCloudProviders(providerState), 650);
  }
  function syncModelLabel() {
    const config = currentModelConfig();
    panel.querySelector('[data-model-label]').textContent = config?.displayName || '选择模型';
    syncContextUsage();
  }
  function syncBusy() {
    const busy = tasks.has(activeConversation(conversationState).id);
    const compacting = state.compacting;
    panel.classList.toggle('is-busy', busy || compacting);
    send.innerHTML = busy ? stopIcon() : sendIcon();
    send.disabled = compacting;
    send.title = compacting ? '正在压缩上下文' : busy ? '停止当前对话生成' : '发送';
    syncPanelStatus();
  }
  function setLayout(layout, { persist = true } = {}) {
    const next = ['floating', 'docked'].includes(layout) ? layout : 'floating';
    panel.dataset.layout = next;
    if (next === 'docked') setCollapsed(false, { persist: false });
    if (persist) localStorage.setItem(LAYOUT_KEY, next);
    syncLayoutClass();
  }
  function setCollapsed(collapsed, { persist = true } = {}) {
    const next = !!collapsed;
    panel.classList.toggle('is-collapsed', next);
    panel.querySelector('[data-collapse]').title = next ? '展开面板' : '折叠面板';
    panel.querySelector('[data-collapse]').innerHTML = next ? panelExpandIcon() : panelCollapseIcon();
    if (persist) localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
    if (next) closeSubpanel();
    syncPanelStatus();
  }
  function syncLayoutClass() {
    const docked = panel.classList.contains('is-open') && panel.dataset.layout === 'docked';
    document.body.classList.toggle('ai-layout-docked', docked);
    clearTimeout(state.layoutResizeTimer);
    state.layoutResizeTimer = setTimeout(() => window.dispatchEvent(new Event('resize')), 240);
  }
  function syncPanelStatus() {
    const task = tasks.get(activeConversation(conversationState).id);
    const busy = !!task;
    if (state.compacting) {
      const status = panel.querySelector('[data-panel-status]');
      status.textContent = '压缩中';
      status.classList.add('is-running');
      return;
    }
    const status = panel.querySelector('[data-panel-status]');
    status.textContent = !busy ? '待命' : task.status === 'reconnecting' ? `恢复中${task.retryAttempt ? ` · ${task.retryAttempt}/3` : ''}` : '生成中';
    status.classList.toggle('is-running', busy);
  }
  async function restoreCloudMessages() {
    if (!sessionSnapshot().user) return;
    let remote;
    try { remote = (await serverApi.listTasks({ projectId })).tasks || []; }
    catch { return; }
    const byId = new Map(remote.map((task) => [task.id, task]));
    for (const conversation of conversationState.conversations) {
      for (const message of conversation.messages) {
        if (!message.cloudTaskId) continue;
        const cloudTask = byId.get(message.cloudTaskId);
        if (!cloudTask || message.cloudTaskStatus === cloudTask.status) continue;
        if (cloudTask.status === 'completed') {
          message.content = cloudTask.output || '操作已完成。';
          message.blocks = [];
          appendTextBlock(message, message.content);
          message.cloudTaskStatus = cloudTask.status;
          persistConversation(conversation);
          updateAssistantDom(conversation, message);
        } else if (['failed', 'cancelled'].includes(cloudTask.status)) {
          message.content = cloudTask.status === 'cancelled' ? '（已停止）' : `请求失败：${cloudTask.error || '云端任务失败'}`;
          message.blocks = [];
          appendTextBlock(message, message.content);
          message.cloudTaskStatus = cloudTask.status;
          persistConversation(conversation);
          updateAssistantDom(conversation, message);
        } else if (!tasks.has(conversation.id)) {
          const aborter = new AbortController();
          tasks.set(conversation.id, { aborter, message, status: cloudTask.status });
          syncBusy();
          waitForCloudTask(message.cloudTaskId, aborter.signal).then((finished) => {
            message.cloudTaskStatus = finished.status;
            message.content = finished.status === 'completed' ? (finished.output || '操作已完成。') : `请求失败：${finished.error || '云端任务未完成'}`;
            message.blocks = [];
            appendTextBlock(message, message.content);
          }).catch((error) => {
            message.content = `请求失败：${error?.message || error}`;
            message.blocks = [];
            appendTextBlock(message, message.content);
          }).finally(() => {
            tasks.delete(conversation.id);
            persistConversation(conversation);
            updateAssistantDom(conversation, message);
            syncBusy();
          });
        }
      }
    }
  }
  function setOpen(open) {
    panel.classList.toggle('is-open', open);
    launcher.classList.toggle('is-hidden', open);
    localStorage.setItem(OPEN_KEY, open ? '1' : '0');
    syncLayoutClass();
    syncPanelStatus();
    if (open) {
      setTimeout(() => input.focus(), 220);
    }
  }
  const api = {
    setSelectedNode(nodeId) { if (ctx.model?.nodeById?.has(nodeId)) selectedNodeId = nodeId; },
    open() { setOpen(true); },
    attachSelection(span) { return addContextAttachment(graphSelectionAttachment(ctx.model, span)); },
    attachNode(nodeId) { return addContextAttachment(graphNodeAttachment(ctx.model, nodeId)); },
    attachMember(member) { return addContextAttachment(graphMemberAttachment(ctx.model, member)); },
    attachTag(tag, member) { return addContextAttachment(graphTagAttachment(ctx.model, tag, member)); },
    attachNote(note) { return addContextAttachment(graphNoteAttachment(ctx.model, note, ctx.graph?.getTags?.() || [])); },
    attachTagNote(tag, member, note) { return addContextAttachment(graphNoteAttachment(ctx.model, note, ctx.graph?.getTags?.() || [tag])); },
  };
  panel._aiPanelApi = api;
  syncActiveWorkspaceFiles();
  queueMicrotask(() => restoreCloudMessages());
  return api;
}

export function navigateGraphReference(ctx, node, label = null) {
  if (!ctx || !node) return null;
  const labelId = label?.id || '';
  if (ctx._reader?.el?.isConnected) {
    ctx.openDetails?.(node.id, { labelId });
    return 'details';
  }
  const scale = ctx.graph?.getZoomScale?.();
  ctx.graph?.focusNode?.(node.id, scale);
  ctx.modals?.openFromNode?.(node, labelId ? { scrollLabel: labelId } : {});
  return 'graph';
}

export function isScrollNearBottom(element, threshold = 120) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

async function waitForCloudTask(taskId, signal, onStatus) {
  while (true) {
    if (signal?.aborted) {
      try { await serverApi.cancelTask(taskId); } catch { /* task may already be terminal */ }
      throw signal.reason || new DOMException('Aborted', 'AbortError');
    }
    const { task } = await serverApi.getTask(taskId);
    onStatus?.(task);
    if (['completed', 'failed', 'cancelled'].includes(task.status)) return task;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 850);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason || new DOMException('Aborted', 'AbortError')); }, { once: true });
    });
  }
}

async function uploadCloudFiles(workspace, attachments, scope) {
  for (const attachment of attachments || []) {
    if (!attachment?.path) continue;
    const file = await workspace.readFile(attachment.path);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    await serverApi.putFile({
      scope,
      path: attachment.path,
      name: attachment.name || file.name || attachment.path.split('/').at(-1),
      type: attachment.type || file.type || 'application/octet-stream',
      data: btoa(binary),
    });
  }
}

async function syncWorkspaceFiles(workspace, scope) {
  const [localFiles, remoteResult] = await Promise.all([workspace.listFiles(), serverApi.listFiles(scope)]);
  const localByPath = new Map(localFiles.map((file) => [file.path, file]));
  const remoteByPath = new Map((remoteResult.files || []).map((file) => [file.path, file]));
  for (const file of localFiles) {
    const remote = remoteByPath.get(file.path);
    if (!remote || Number(file.updatedAt || 0) >= Date.parse(remote.updatedAt || 0)) await uploadCloudFiles(workspace, [file], scope);
  }
  for (const remote of remoteResult.files || []) {
    const local = localByPath.get(remote.path);
    if (local && Number(local.updatedAt || 0) >= Date.parse(remote.updatedAt || 0)) continue;
    const full = (await serverApi.getFile(scope, remote.path)).file;
    const binary = atob(full.data || '');
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    await workspace.writeFile(remote.path, new Blob([bytes], { type: full.type || 'application/octet-stream' }));
  }
}

export function replaceUserMessageBranch(messages, index, content, editedAt = new Date().toISOString()) {
  const original = messages[index];
  if (original?.role !== 'user') return [...messages];
  return [...messages.slice(0, index), { ...original, content, editedAt }];
}

export function noteFromAssistantMessage(message, { id = '', now = '' } = {}) {
  const content = String(message?.content || '').trim();
  if (!content) return null;
  const timestamp = now || new Date().toISOString();
  return {
    id: id || `note-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: '',
    content,
    tagPointer: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function normalizeAiText(value = '') {
  return String(value ?? '').trim();
}

export function activityTimelineEntries(activity) {
  return activity.map((block, index) => ({ block, index }));
}

export function shouldJoinActivityBlock(previous, next) {
  if (!next || (next.type !== 'reasoning' && next.type !== 'tool')) return false;
  return previous?.type === 'reasoning' || previous?.type === 'tool';
}

export function isActivityGroupActive(activity, { messageActive = false, isTail = false } = {}) {
  if (activity.some((block) => block.type === 'tool' && ['queued', 'running'].includes(block.status))) return true;
  return messageActive && isTail;
}

function renderEmpty(container, submitPrompt) {
  const empty = document.createElement('div');
  empty.className = 'ai-empty';
  empty.innerHTML = `${sparkIcon()}<h2>从哪里开始？</h2><p>我可以理解当前图谱、搜索资料或分析本对话中的文件。</p>`;
  const grid = document.createElement('div');
  grid.className = 'ai-starters';
  for (const prompt of STARTER_PROMPTS) {
    const b = button('ai-starter', prompt, `填入：${prompt}`);
    b.type = 'button';
    b.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      submitPrompt(prompt);
    });
    grid.append(b);
  }
  empty.append(grid);
  container.append(empty);
}

function initResize(panel) {
  const handle = panel.querySelector('[data-resize]');
  handle.addEventListener('pointerdown', (event) => {
    if (matchMedia('(max-width: 720px)').matches) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    panel.classList.add('is-resizing');
    const move = (ev) => applyWidth(panel, innerWidth - ev.clientX);
    const up = () => {
      panel.classList.remove('is-resizing');
      localStorage.setItem(WIDTH_KEY, String(Math.round(panel.getBoundingClientRect().width)));
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      window.dispatchEvent(new Event('resize'));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}

function applyWidth(panel, width) {
  const value = Math.max(340, Math.min(innerWidth * 0.6, Number(width) || innerWidth / 3));
  panel.style.setProperty('--ai-panel-width', `${Math.round(value)}px`);
  document.documentElement.style.setProperty('--ai-panel-width', `${Math.round(value)}px`);
}

function activityGroupSignature(activity, active) {
  return JSON.stringify({
    active,
    activity: activity.map((block) => block.type === 'reasoning'
      ? { type: 'reasoning' }
      : {
          type: 'tool', key: block.key, name: block.name, status: block.status, batch: block.batch,
          error: block.error || '', results: block.result?.results?.length ?? null,
          resultReady: block.result !== undefined,
        }),
  });
}

function summarizeTool(event) {
  const input = JSON.stringify(event.args || {}, null, 2);
  if (event.status === 'running') return `输入\n${input}`;
  if (event.error) return `输入\n${input}\n\n错误\n${event.error}`;
  const output = JSON.stringify(event.result ?? null, null, 2);
  return `输入\n${input}\n\n输出\n${output}`.slice(0, 6000);
}

function toolLabel(name) {
  return ({
    list_workspace: '查看对话文件', read_file: '读取文件', search_files: '搜索文件', read_pdf: '解析 PDF', write_file: '写入文件',
    web_search: '联网搜索', open_url: '读取网页', resolve_doi: '解析 DOI', graph_overview: '理解图谱',
    search_graph_nodes: '搜索图谱节点', get_graph_node: '读取图谱节点', get_graph_nodes: '批量读取图谱节点', get_graph_neighbors: '读取节点关系', get_graph_neighbors_batch: '批量读取节点关系',
    list_tag_notes: '查看标签笔记', get_tag_note: '读取标签笔记', create_tag_note: '创建标签笔记', update_tag_note: '更新标签笔记', delete_tag_note: '删除标签笔记',
    locate_graph_reference: '定位图谱引用', focus_graph_node: '打开图谱节点',
  })[name] || name;
}
function statusLabel(status) { return ({ queued: '等待执行', running: '执行中', done: '完成', 'not-found': '未找到' , error: '失败' })[status] || status; }
function displayCitation(value) { const match = /^\[S(\d+)\]$/.exec(value || ''); return match ? `[${match[1]}]` : value || ''; }
function hostname(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }
function uniqueWebResults(results) {
  const seen = new Set();
  return results.filter((result) => {
    if (!result?.url) return false;
    const key = result.url.replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function createSiteIcon(url) {
  const icon = document.createElement('span');
  icon.className = 'ai-site-icon';
  icon.innerHTML = globeIcon();
  try {
    const img = document.createElement('img');
    img.src = `${new URL(url).origin}/favicon.ico`;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => img.remove(), { once: true });
    icon.append(img);
  } catch { /* keep the globe fallback */ }
  return icon;
}
function loadJson(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function formatBytes(bytes) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 ** 2).toFixed(1)} MB`; }
function truncateText(value, max) { const text = String(value || '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max).trim()}…` : text; }
function formatConversationTime(value) { const date = new Date(value || 0); return Number.isFinite(date.getTime()) ? date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : ''; }
function isLegacyFileImportNotice(message) { return message?.role === 'notice' && /^已加入当前对话：/.test(message.content || ''); }
function button(className, text, title) { const b = document.createElement('button'); b.type = 'button'; b.className = className; b.textContent = text; b.title = title; return b; }
function escapeHtml(v) { return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function escapeAttr(v) { return escapeHtml(v); }
async function copyToClipboard(value) {
  const text = String(value || '');
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function sparkIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l1.7 5.3L19 9l-5.3 1.7L12 16l-1.7-5.3L5 9l5.3-1.7L12 2zm6 12l.9 2.6L21.5 18l-2.6.9L18 21.5l-.9-2.6-2.6-.9 2.6-1.4L18 14z" fill="currentColor"/></svg>'; }
function closeIcon() { return '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'; }
function settingsIcon() { return '<svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M7 14v6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'; }
function newChatIcon() { return '<svg viewBox="0 0 24 24"><path d="M5 5h10a4 4 0 014 4v5a4 4 0 01-4 4H9l-4 3v-3a3 3 0 01-2-3V7a2 2 0 012-2zM12 8v6M9 11h6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'; }
function paperclipIcon() { return '<svg viewBox="0 0 24 24"><path d="M8 12.5l6.2-6.2a3 3 0 114.2 4.2l-8.1 8.1a5 5 0 01-7.1-7.1l8.2-8.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'; }
function sendIcon() { return '<svg viewBox="0 0 24 24"><path d="M4 11.5L20 4l-5.5 16-3.1-6-7.4-2.5zM11.4 14L20 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>'; }
function stopIcon() { return '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>'; }
function copyIcon() { return '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>'; }
function editIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19h4l10-10-4-4L5 15v4zM13.8 6.2l4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
function debugCopyIcon() { return '<svg viewBox="0 0 24 24"><path d="M8 7L4 12l4 5M16 7l4 5-4 5M14 4l-4 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
function regenerateIcon() { return '<svg viewBox="0 0 24 24"><path d="M19 8V4l-2 2a8 8 0 10.6 11.3M19 4h-4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
function noteAddIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5h11l3 3V20.5H5zM16 3.5v4h3M8 12h8M12 8v8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
function globeIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3.8 12h16.4M12 3.5c2.2 2.3 3.3 5.1 3.3 8.5S14.2 18.2 12 20.5C9.8 18.2 8.7 15.4 8.7 12S9.8 5.8 12 3.5z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>'; }
function folderIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5h6l2-2h9v13h-17z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>'; }
function fileIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.8h6l4 4v10.4H5zM11 2.8v4h4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>'; }
function trashIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V4h6v3M7.5 7l.8 13h7.4l.8-13M10 11v5M14 11v5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
function chevronIcon() { return '<svg class="ai-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="M6.5 8l3.5 3.5L13.5 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
function activityIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.8l1.4 4.1 4.1 1.4-4.1 1.4-1.4 4.1-1.4-4.1-4.1-1.4 4.1-1.4L10 2.8zm5.1 10.1l.7 2 .2.1-2 .7-.7 2-.7-2-2-.7 2-.7.7-2 .7 2z" fill="currentColor"/></svg>'; }
function spinnerIcon() { return '<svg class="ai-spinner" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-opacity=".2" stroke-width="2"/><path d="M10 3a7 7 0 014.95 2.05" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'; }
function graphContextIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="6" cy="6" r="2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="14" cy="6" r="2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="10" cy="14" r="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M7.7 7.1l1.5 4.7M12.3 7.1l-1.5 4.7M8 6h4" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>'; }
function quoteIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.2 5.2h4.6v4.2a4.4 4.4 0 01-4.1 4.5M11.2 5.2h4.6v4.2a4.4 4.4 0 01-4.1 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
function panelCollapseIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 8h10M7 12h6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'; }
function panelExpandIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 12h10M7 8h6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'; }
function panelLayoutIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4" width="14" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M12 4v12" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>'; }
function plusIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'; }
function layoutModeIcon(mode) {
  if (mode === 'docked') return '<svg viewBox="0 0 20 20"><rect x="2.5" y="4" width="15" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M12 4v12" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
  return '<svg viewBox="0 0 20 20"><rect x="4" y="3" width="13" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 7v8.5a2 2 0 002 2H13" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
}
function checkIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 10.2l3.2 3.2 7.8-7.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
function alertIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 6.2v4.7M10 14h.01" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'; }
function toolIconFor(name) {
  const group = toolIconGroup(name);
  if (group === 'graph') return graphContextIcon();
  if (group === 'web') return globeIcon();
  return toolIcon();
}
function toolIconGroup(name) {
  const value = String(name || '');
  if (value.startsWith('graph_') || ['search_graph_nodes', 'get_graph_node', 'get_graph_nodes', 'get_graph_neighbors', 'get_graph_neighbors_batch', 'locate_graph_reference', 'focus_graph_node', 'list_tag_notes', 'get_tag_note', 'create_tag_note', 'update_tag_note', 'delete_tag_note'].includes(value)) return 'graph';
  if (['web_search', 'open_url', 'resolve_doi'].includes(value)) return 'web';
  return 'default';
}
function toolIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.2 4.1a4 4 0 004.7 5.2l3.7 3.7a1.8 1.8 0 01-2.6 2.6l-3.7-3.7a4 4 0 01-5.2-4.7l2.5 2.5 2-2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
function linkIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8.2 11.8l3.6-3.6M7 14l-1 1a2.8 2.8 0 01-4-4l2.4-2.4a2.8 2.8 0 014 0M13 6l1-1a2.8 2.8 0 014 4l-2.4 2.4a2.8 2.8 0 01-4 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'; }
