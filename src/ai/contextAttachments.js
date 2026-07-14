const CONTEXT_LIMIT = 18000;

export function graphSelectionAttachment(model, span) {
  const node = model?.nodeById?.get(span?.node);
  if (!node || !span?.text) return null;
  const section = span.section === 'proof' ? 'proof' : 'statement';
  const source = section === 'proof' ? (node.proofBody || '') : (node.statementBody || '');
  const start = clamp(span.start, 0, source.length);
  const end = clamp(span.end, start, source.length);
  return {
    id: `selection:${node.id}:${section}:${start}:${end}`,
    kind: 'graph-selection',
    nodeId: node.id,
    section,
    start,
    end,
    text: String(span.text).trim(),
    before: source.slice(Math.max(0, start - 160), start),
    after: source.slice(end, Math.min(source.length, end + 240)),
    label: `${nodeNumber(node)} · 选中片段`,
  };
}

export function graphNodeAttachment(model, nodeId) {
  const node = model?.nodeById?.get(nodeId);
  if (!node) return null;
  return { id: `node:${node.id}`, kind: 'graph-node', nodeId: node.id, label: `${nodeNumber(node)} · 整个节点` };
}

export function graphFileAttachment(file) {
  if (!file?.path) return null;
  return { id: `file:${file.path}`, kind: 'file-reference', path: file.path, label: file.name || file.path };
}

export function aiQuoteAttachment(message, messageIndex, selectedText, conversationTitle = '') {
  const text = String(selectedText || '').trim().slice(0, 6000);
  if (!message || message.role !== 'assistant' || !text) return null;
  const source = String(message.content || '');
  const found = source.indexOf(text);
  const start = found >= 0 ? found : 0;
  const end = found >= 0 ? found + text.length : text.length;
  const sourceId = message.createdAt || `${messageIndex}`;
  return {
    id: `ai-quote:${sourceId}:${start}:${end}`,
    kind: 'ai-quote',
    messageIndex,
    conversationTitle,
    text,
    before: found >= 0 ? source.slice(Math.max(0, start - 160), start) : '',
    after: found >= 0 ? source.slice(end, Math.min(source.length, end + 240)) : '',
    label: `AI 回复 · ${text.replace(/\s+/g, ' ').slice(0, 28)}${text.length > 28 ? '…' : ''}`,
  };
}

export function appendUniqueContext(items, attachment) {
  if (!attachment) return [...(items || [])];
  return [...(items || []).filter((item) => item.id !== attachment.id), attachment];
}

export function contextPrompt(text, attachments, model) {
  const blocks = (attachments || []).map((item) => describeContext(item, model)).filter(Boolean);
  if (!blocks.length) return String(text || '');
  const selectionScoped = (attachments || []).some((item) => item.kind === 'graph-selection')
    && !(attachments || []).some((item) => item.kind === 'graph-node');
  const quoteScoped = (attachments || []).some((item) => item.kind === 'ai-quote');
  const scopeRules = `${selectionScoped ? `
<selection_scope priority="high">
选中内容是本次问题的唯一主要解释对象。节点信息、位置、前文和后文只用于定位与消歧，不是要求解释的内容。
除非用户明确要求“整个节点”“全文”“完整证明”“依赖关系”或同等范围，否则：
1. 只回答选中内容直接涉及的含义、符号与局部推理；不要概述整个定理或整段证明。
2. 若附件已足够回答，不要调用 get_graph_node、get_graph_neighbors 或其他工具扩展到完整节点。
3. 不要因为存在 node_id 就主动补充该节点的全局地位、完整结构或全部依赖。
</selection_scope>` : ''}${quoteScoped ? `
<conversation_quote_scope priority="high">
用户引用的是先前 AI 回复中的指定片段。请直接围绕 quoted_text 回答；相邻文本仅用于消歧。除非用户明确要求，不要重新概述整条回复。
</conversation_quote_scope>` : ''}`;
  return `${String(text || '')}\n\n<attached_context>${scopeRules}\n${blocks.join('\n\n')}\n</attached_context>`;
}

export function mentionQueryAt(value, caret = String(value || '').length) {
  const prefix = String(value || '').slice(0, caret);
  const match = prefix.match(/(?:^|\s)@([^\s@]*)$/u);
  if (!match) return null;
  return { query: match[1], start: caret - match[1].length - 1, end: caret };
}

export function replaceMention(value, mention, label) {
  if (!mention) return { value, caret: String(value || '').length };
  const token = `@${String(label || '').replace(/\s+/g, ' ').trim()} `;
  const next = `${value.slice(0, mention.start)}${token}${value.slice(mention.end)}`;
  return { value: next, caret: mention.start + token.length };
}

export function searchMentionCandidates(model, files, query, limit = Infinity) {
  const needle = String(query || '').trim().toLowerCase();
  const nodes = (model?.nodes || []).map((node) => {
    const number = nodeNumber(node);
    const haystack = `${node.id} ${number} ${node.title || ''} ${node.typeLabel || node.type || ''}`.toLowerCase();
    const score = !needle ? (node.importance || 0) + 1 : haystack === needle ? 100 : haystack.startsWith(needle) ? 50 : haystack.includes(needle) ? 20 : 0;
    return score ? { kind: 'node', score, node, label: number, detail: node.title || node.id } : null;
  }).filter(Boolean);
  const fileItems = (files || []).map((file) => {
    const haystack = `${file.name || ''} ${file.path || ''}`.toLowerCase();
    const score = !needle ? 1 : haystack.startsWith(needle) ? 45 : haystack.includes(needle) ? 15 : 0;
    return score ? { kind: 'file', score, file, label: file.name || file.path, detail: file.path } : null;
  }).filter(Boolean);
  const sorted = [...nodes, ...fileItems].sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return Number.isFinite(limit) ? sorted.slice(0, Math.max(0, limit)) : sorted;
}

function describeContext(item, model) {
  if (item.kind === 'file-reference') return `引用文件：${item.path}\n需要内容时请调用 read_file 或 read_pdf。`;
  if (item.kind === 'ai-quote') {
    return `[AI 对话引用片段]\n<quoted_text>\n${item.text}\n</quoted_text>\n来源：${item.conversationTitle || '当前对话'}第 ${Number(item.messageIndex) + 1} 条消息\n<disambiguation_context>\n前文：${item.before || ''}\n后文：${item.after || ''}\n</disambiguation_context>`;
  }
  const node = model?.nodeById?.get(item.nodeId);
  if (!node) return '';
  const meta = `节点：${nodeNumber(node)}\nnode_id：${node.id}\n标题：${node.title || ''}\n图谱位置：全局第 ${(model.nodes || []).indexOf(node) + 1} 个节点；坐标 (${round(node.x)}, ${round(node.y)})`;
  if (item.kind === 'graph-selection') {
    return `[图谱选中片段]\n<selected_text>\n${item.text}\n</selected_text>\n${meta}\n所在部分：${item.section}\n字符范围：${item.start}-${item.end}\n<disambiguation_context>\n前文：${item.before}\n后文：${item.after}\n</disambiguation_context>`;
  }
  if (item.kind === 'graph-node') {
    const content = [`正文：\n${node.statementBody || ''}`, node.proofBody ? `证明/详情：\n${node.proofBody}` : ''].filter(Boolean).join('\n\n');
    return `[完整图谱节点]\n${meta}\n${content.slice(0, CONTEXT_LIMIT)}${content.length > CONTEXT_LIMIT ? '\n…（内容已截断，可调用 get_graph_node 继续读取）' : ''}`;
  }
  return '';
}

function nodeNumber(node) { return String(node.number || node.tag || node.id); }
function clamp(value, min, max) { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min; }
function round(value) { return Number.isFinite(value) ? Math.round(value * 10) / 10 : '未知'; }
