import { graphReferenceHref, graphReferenceMarkdown, graphReferenceToMember, noteReferenceFromNote, resolveTagNoteReference, tagReferenceFromInstance } from '../data/graphReference.js';
import {
  fileFragmentReference,
  fileFragmentReferenceHref,
  fileFragmentReferenceMarkdown,
  isFileFragmentReference,
} from '../data/fileReference.js';
import { notePointerFromMember, resolveNotePointer } from '../data/notes.js';
import { memberInstanceId, memberNode, memberReferenceId, memberType } from '../data/schema.js';

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

export function graphMemberAttachment(model, member) {
  if (!member) return null;
  if (typeof member === 'string' || member.type === 'node') return graphNodeAttachment(model, typeof member === 'string' ? member : member.node);
  if (member.type === 'span') return graphSelectionAttachment(model, member);
  const node = model?.nodeById?.get(member.node);
  if (!node) return null;
  return {
    id: `position:${node.id}:${member.section || 'statement'}:${member.start ?? `${member.x},${member.y}`}`,
    kind: 'graph-position',
    nodeId: node.id,
    section: member.section === 'proof' ? 'proof' : 'statement',
    start: Number.isFinite(member.start) ? member.start : null,
    x: Number.isFinite(member.x) ? member.x : null,
    y: Number.isFinite(member.y) ? member.y : null,
    label: `${nodeNumber(node)} · 标注位置`,
  };
}

export function graphTagAttachment(model, tag, member) {
  const nodeId = memberNode(member);
  const node = model?.nodeById?.get(nodeId);
  const reference = tagReferenceFromInstance(model, tag, member);
  if (!node || !reference) return null;
  const type = memberType(member);
  const section = member?.section === 'proof' ? 'proof' : 'statement';
  const source = section === 'proof' ? (node.proofBody || '') : (node.statementBody || '');
  const start = Number.isFinite(member?.start) ? clamp(member.start, 0, source.length) : null;
  const end = Number.isFinite(member?.end) ? clamp(member.end, start ?? 0, source.length) : null;
  const text = String(member?.text || (start !== null && end !== null ? source.slice(start, end) : '')).trim();
  return {
    id: `tag:${tag.id}:${memberInstanceId(member)}`,
    kind: 'graph-tag',
    tagId: tag.id,
    tagLabel: tag.label || tag.id,
    instanceId: memberInstanceId(member),
    referenceId: memberReferenceId(member),
    memberType: type,
    nodeId,
    section,
    start,
    end,
    x: Number.isFinite(member?.x) ? member.x : null,
    y: Number.isFinite(member?.y) ? member.y : null,
    text,
    before: start !== null ? source.slice(Math.max(0, start - 160), start) : '',
    after: end !== null ? source.slice(end, Math.min(source.length, end + 240)) : '',
    label: reference.label,
    referenceHref: graphReferenceHref(reference),
    referenceMarkdown: graphReferenceMarkdown(reference),
  };
}

export function graphTagNoteAttachment(model, tag, member, note) {
  return graphNoteAttachment(model, { ...note, tagPointer: note?.tagPointer || notePointerFromMember(tag, member) }, tag && member ? [tag] : []);
}

export function graphNoteAttachment(model, note, tags = []) {
  const resolved = resolveNotePointer(note, tags);
  const tag = resolved?.tag || null;
  const member = resolved?.member || null;
  const reference = noteReferenceFromNote(model, note, tags);
  const nodeId = member ? memberNode(member) : null;
  if (!reference) return null;
  return {
    id: `note:${note.id}`,
    kind: 'graph-tag-note',
    tagId: tag?.id || null,
    tagLabel: tag ? (tag.label || tag.id) : '',
    instanceId: member ? memberInstanceId(member) : '',
    referenceId: member ? memberReferenceId(member) : '',
    memberType: member ? memberType(member) : null,
    noteId: note.id,
    noteTitle: reference.noteTitle,
    nodeId,
    title: String(note.title || ''),
    content: String(note.content || ''),
    label: reference.label,
    referenceHref: graphReferenceHref(reference),
    referenceMarkdown: graphReferenceMarkdown(reference),
  };
}

export function graphReferenceAttachment(model, reference, tags = [], notes = []) {
  if (reference?.kind === 'tag-note-reference' || reference?.type === 'tag-note') {
    const resolved = resolveTagNoteReference(reference, tags, notes);
    return resolved ? graphNoteAttachment(model, resolved.note, tags) : null;
  }
  if (reference?.kind === 'tag-reference' || reference?.type === 'tag') {
    const tag = (tags || []).find((item) => item.id === reference.tagId);
    const member = graphReferenceToMember(reference, tags);
    return tag && member ? graphTagAttachment(model, tag, member) : null;
  }
  return graphMemberAttachment(model, graphReferenceToMember(reference));
}

export function graphFileAttachment(file) {
  if (!file?.path) return null;
  return { id: `file:${file.path}`, kind: 'file-reference', path: file.path, label: file.name || file.path };
}

export function pdfFieldAttachment({ path, name, page, text, rects = [], conversationId = '' } = {}) {
  const reference = fileFragmentReference({ path, name, format: 'pdf', page, text, rects, conversationId });
  return fileFragmentAttachment(reference, conversationId);
}

export function fileExcerptAttachment({
  path, name, format = '', text, start = null, end = null, before = '', after = '', conversationId = '',
} = {}) {
  const reference = fileFragmentReference({ path, name, format, text, start, end, before, after, conversationId });
  return fileFragmentAttachment(reference, conversationId);
}

export function fileFragmentAttachment(reference, conversationId = '') {
  if (!isFileFragmentReference(reference)) return null;
  const scopedReference = { ...reference, conversationId: conversationId || reference.conversationId || '' };
  return {
    id: `file-fragment:${reference.path}:${shortHash(fileFragmentReferenceHref(scopedReference))}`,
    ...scopedReference,
    kind: 'file-fragment',
    label: scopedReference.format === 'pdf'
      ? `${scopedReference.fileName || scopedReference.path} · p. ${scopedReference.page}`
      : `${scopedReference.fileName || scopedReference.path} · 选中片段`,
    referenceHref: fileFragmentReferenceHref(scopedReference),
    referenceMarkdown: fileFragmentReferenceMarkdown(scopedReference),
  };
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
  const graphSelectionScoped = (attachments || []).some((item) => item.kind === 'graph-selection' || (item.kind === 'graph-tag' && item.memberType === 'span'))
    && !(attachments || []).some((item) => item.kind === 'graph-node');
  const pdfFieldScoped = (attachments || []).some((item) => item.kind === 'pdf-field' || (item.kind === 'file-fragment' && item.format === 'pdf'));
  const fileExcerptScoped = (attachments || []).some((item) => item.kind === 'file-excerpt' || (item.kind === 'file-fragment' && item.format !== 'pdf'));
  const quoteScoped = (attachments || []).some((item) => item.kind === 'ai-quote');
  const scopeRules = `${graphSelectionScoped ? `
<selection_scope priority="high">
选中内容是本次问题的唯一主要解释对象。节点信息、位置、前文和后文只用于定位与消歧，不是要求解释的内容。
除非用户明确要求“整个节点”“全文”“完整证明”“依赖关系”或同等范围，否则：
1. 只回答选中内容直接涉及的含义、符号与局部推理；不要概述整个定理或整段证明。
2. 若附件已足够回答，不要调用 get_graph_node、get_graph_neighbors 或其他工具扩展到完整节点。
3. 不要因为存在 node_id 就主动补充该节点的全局地位、完整结构或全部依赖。
</selection_scope>` : ''}${pdfFieldScoped ? `
<pdf_field_scope priority="high">
PDF 字段引用中的 selected_text 是本次问题的主要解释对象，文件名、页码和页面坐标只用于定位。
除非用户明确要求整页或整份文件，否则只围绕所选字段回答；附件已足够时不要再次读取整份 PDF。
</pdf_field_scope>` : ''}${fileExcerptScoped ? `
<file_excerpt_scope priority="high">
文件片段引用中的 selected_text 是本次问题的主要解释对象，文件路径和相邻文本只用于定位与消歧。
除非用户明确要求整份文件，否则只围绕选中片段回答；附件已足够时不要再次读取完整文件。
</file_excerpt_scope>` : ''}${quoteScoped ? `
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
  if (item.kind === 'pdf-field') {
    const positions = (item.rects || []).map((rect) => `(${rect.x}, ${rect.y}, ${rect.width}, ${rect.height})`).join('；');
    return `[PDF 字段引用]\n文件：${item.fileName || item.path}\n路径：${item.path}\n页码：${item.page}\n页面归一化位置 (x, y, width, height)：${positions || '未记录'}\n<selected_text>\n${item.text}\n</selected_text>`;
  }
  if (item.kind === 'file-excerpt') {
    return `[文件片段引用]\n文件：${item.fileName || item.path}\n路径：${item.path}\n<selected_text>\n${item.text}\n</selected_text>\n<disambiguation_context>\n前文：${item.before || ''}\n后文：${item.after || ''}\n</disambiguation_context>`;
  }
  if (item.kind === 'file-fragment') {
    const reference = item.referenceMarkdown || fileFragmentReferenceMarkdown(item);
    if (item.format === 'pdf') {
      const positions = (item.rects || []).map((rect) => `(${rect.x}, ${rect.y}, ${rect.width}, ${rect.height})`).join('；');
      return `[文件片段引用]\n文件：${item.fileName || item.path}\n路径：${item.path}\n页码：${item.page}\n引用链接：${reference}\n页面归一化位置 (x, y, width, height)：${positions || '未记录'}\n<selected_text>\n${item.text}\n</selected_text>`;
    }
    return `[文件片段引用]\n文件：${item.fileName || item.path}\n路径：${item.path}\n引用链接：${reference}\n字符范围：${item.start ?? '未记录'}-${item.end ?? '未记录'}\n<selected_text>\n${item.text}\n</selected_text>\n<disambiguation_context>\n前文：${item.before || ''}\n后文：${item.after || ''}\n</disambiguation_context>`;
  }
  if (item.kind === 'ai-quote') {
    return `[AI 对话引用片段]\n<quoted_text>\n${item.text}\n</quoted_text>\n来源：${item.conversationTitle || '当前对话'}第 ${Number(item.messageIndex) + 1} 条消息\n<disambiguation_context>\n前文：${item.before || ''}\n后文：${item.after || ''}\n</disambiguation_context>`;
  }
  const node = model?.nodeById?.get(item.nodeId);
  if (item.kind === 'graph-tag-note') {
    const location = item.tagId
      ? `标签：${item.tagLabel}\ntag_id：${item.tagId}\nreference_id：${item.referenceId || ''}`
      : '标签：无（游离笔记）';
    const nodeMeta = node ? `\n节点：${nodeNumber(node)}\nnode_id：${node.id}\n标题：${node.title || ''}` : '';
    return `[图谱笔记]\n${location}\nnote_id：${item.noteId}\n引用链接：${item.referenceMarkdown}${nodeMeta}\n笔记标题：${item.title || '（无标题）'}\n<note_content>\n${String(item.content || '').slice(0, CONTEXT_LIMIT)}\n</note_content>`;
  }
  if (!node) return '';
  const meta = `节点：${nodeNumber(node)}\nnode_id：${node.id}\n标题：${node.title || ''}\n图谱位置：全局第 ${(model.nodes || []).indexOf(node) + 1} 个节点；坐标 (${round(node.x)}, ${round(node.y)})`;
  if (item.kind === 'graph-selection') {
    return `[图谱选中片段]\n<selected_text>\n${item.text}\n</selected_text>\n${meta}\n所在部分：${item.section}\n字符范围：${item.start}-${item.end}\n<disambiguation_context>\n前文：${item.before}\n后文：${item.after}\n</disambiguation_context>`;
  }
  if (item.kind === 'graph-position') {
    return `[图谱标注位置]\n${meta}\n所在部分：${item.section}\n字符位置：${item.start ?? '未记录'}\n相对坐标：(${item.x ?? '未知'}, ${item.y ?? '未知'})`;
  }
  if (item.kind === 'graph-tag') {
    const target = item.memberType === 'span'
      ? `标注文本：\n<selected_text>\n${item.text || ''}\n</selected_text>\n字符范围：${item.start ?? '未记录'}-${item.end ?? '未记录'}\n<disambiguation_context>\n前文：${item.before || ''}\n后文：${item.after || ''}\n</disambiguation_context>`
      : item.memberType === 'pos'
        ? `标注位置：${item.section}，字符位置 ${item.start ?? '未记录'}，相对坐标 (${item.x ?? '未知'}, ${item.y ?? '未知'})`
        : `标注对象：整个节点\n${[`正文：\n${node.statementBody || ''}`, node.proofBody ? `证明/详情：\n${node.proofBody}` : ''].filter(Boolean).join('\n\n').slice(0, CONTEXT_LIMIT)}`;
    return `[图谱标签实例]\n标签：${item.tagLabel}\ntag_id：${item.tagId}\nreference_id：${item.referenceId}\n引用链接：${item.referenceMarkdown}\n${meta}\n标签实例类型：${item.memberType}\n${target}`;
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
function shortHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
}
