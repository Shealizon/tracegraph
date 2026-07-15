import { memberInstanceId, memberNode, memberReferenceId, memberType, nodeTag } from './schema.js';
import { noteDisplayTitle, notePointerFromMember, resolveNotePointer } from './notes.js';

export function graphReferenceFromMember(model, member, text = '') {
  const nodeId = memberNode(member);
  const node = model?.nodeById?.get(nodeId);
  if (!nodeId) return null;
  const type = memberType(member);
  const label = `${node ? nodeTag(model, node) : nodeId}${node?.title ? ` · ${node.title}` : ''}`;
  const reference = {
    version: 1,
    kind: 'graph-reference',
    type,
    nodeId,
    label,
    text: String(text || (type === 'span' ? member?.text : '') || '').trim(),
  };
  if (type === 'span' || type === 'pos') {
    reference.section = member?.section === 'proof' ? 'proof' : 'statement';
    if (Number.isFinite(member?.start)) reference.start = member.start;
    if (Number.isFinite(member?.end)) reference.end = member.end;
    if (member?.offsetMode) reference.offsetMode = member.offsetMode;
  }
  if (type === 'pos') {
    if (Number.isFinite(member?.x)) reference.x = member.x;
    if (Number.isFinite(member?.y)) reference.y = member.y;
  }
  return reference;
}

export function tagReferenceFromInstance(model, tag, member) {
  const nodeId = memberNode(member);
  const instanceId = memberInstanceId(member);
  const referenceId = memberReferenceId(member);
  if (!tag?.id || !nodeId || !instanceId || !referenceId) return null;
  const node = model?.nodeById?.get(nodeId);
  const tagLabel = String(tag.label || tag.id);
  const reference = {
    version: 1,
    kind: 'tag-reference',
    type: 'tag',
    tagId: tag.id,
    tagLabel,
    instanceId,
    referenceId,
    memberType: memberType(member),
    nodeId,
    label: tagLabel,
    text: String(member?.text || '').trim(),
  };
  if (node) reference.nodeLabel = `${nodeTag(model, node)}${node.title ? ` · ${node.title}` : ''}`;
  return reference;
}

export function tagNoteReferenceFromInstance(model, tag, member, note) {
  return noteReferenceFromNote(model, { ...note, tagPointer: note?.tagPointer || notePointerFromMember(tag, member) }, tag && member ? [tag] : []);
}

export function noteReferenceFromNote(model, note, tags = []) {
  if (!note?.id) return null;
  const resolved = resolveNotePointer(note, tags);
  const base = resolved ? tagReferenceFromInstance(model, resolved.tag, resolved.member) : null;
  const noteTitle = noteDisplayTitle(note);
  return {
    ...(base || {}),
    version: 1,
    kind: 'tag-note-reference',
    type: 'tag-note',
    noteId: String(note.id),
    noteTitle,
    label: noteTitle,
    text: [String(note.title || '').trim(), String(note.content || '')].filter(Boolean).join('\n\n'),
  };
}

export function graphReferenceToMember(reference, tags = [], notes = []) {
  if (reference?.kind === 'tag-note-reference' || reference?.type === 'tag-note') {
    return resolveTagNoteReference(reference, tags, notes)?.member || null;
  }
  if (reference?.kind === 'tag-reference' || reference?.type === 'tag') {
    return resolveTagReference(reference, tags)?.member || null;
  }
  if (!reference?.nodeId) return null;
  if (reference.type === 'node') return reference.nodeId;
  return {
    node: reference.nodeId,
    type: reference.type === 'span' ? 'span' : 'pos',
    section: reference.section === 'proof' ? 'proof' : 'statement',
    ...(Number.isFinite(reference.start) ? { start: reference.start } : {}),
    ...(Number.isFinite(reference.end) ? { end: reference.end } : {}),
    ...(reference.offsetMode ? { offsetMode: reference.offsetMode } : {}),
    ...(reference.text ? { text: reference.text } : {}),
    ...(Number.isFinite(reference.x) ? { x: reference.x } : {}),
    ...(Number.isFinite(reference.y) ? { y: reference.y } : {}),
  };
}

export function resolveTagReference(reference, tags = []) {
  if (!reference?.tagId) return null;
  const tag = (tags || []).find((item) => item.id === reference.tagId);
  if (!tag) return null;
  const member = (tag.members || []).find((item) => {
    if (reference.referenceId && memberReferenceId(item) === reference.referenceId) return true;
    if (reference.instanceId && memberInstanceId(item) === reference.instanceId) return true;
    return false;
  });
  return member ? { tag, member } : null;
}

export function resolveTagNoteReference(reference, tags = [], notes = []) {
  if (!reference?.noteId) return null;
  const note = (notes || []).find((item) => item.id === reference.noteId);
  if (note) return { note, ...(resolveNotePointer(note, tags) || { tag: null, member: null }) };

  // Legacy projects can still surface embedded notes before project migration
  // has been persisted. Keep old links readable during that one load.
  const matches = [];
  for (const tag of tags || []) {
    for (const member of tag.members || []) {
      const movedNote = (Array.isArray(member?.notes) ? member.notes : []).find((item) => item.id === reference.noteId);
      if (movedNote) matches.push({ tag, member, note: movedNote });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

export function graphReferenceHref(reference) {
  if (reference?.kind === 'tag-note-reference' || reference?.type === 'tag-note') {
    if (!reference.noteId) return '';
    const query = new URLSearchParams();
    query.set('graph-note', reference.noteId);
    return `#${query.toString()}`;
  }
  if (reference?.kind === 'tag-reference' || reference?.type === 'tag') {
    if (!reference.tagId || !reference.referenceId) return '';
    const query = new URLSearchParams();
    query.set('graph-tag', reference.tagId);
    query.set('tag-ref', reference.referenceId);
    return `#${query.toString()}`;
  }
  if (!reference?.nodeId) return '';
  const query = new URLSearchParams();
  query.set('graph-node', reference.nodeId);
  query.set('type', reference.type || 'node');
  if (reference.section) query.set('section', reference.section);
  if (Number.isFinite(reference.start)) query.set('start', String(reference.start));
  if (Number.isFinite(reference.end)) query.set('end', String(reference.end));
  if (reference.offsetMode) query.set('offsetMode', reference.offsetMode);
  if (Number.isFinite(reference.x)) query.set('x', String(reference.x));
  if (Number.isFinite(reference.y)) query.set('y', String(reference.y));
  return `#${query.toString()}`;
}

export function graphReferenceMarkdown(reference) {
  if (!reference?.nodeId && !reference?.tagId && !reference?.noteId) return '';
  const isTag = reference.kind === 'tag-reference' || reference.type === 'tag'
    || reference.kind === 'tag-note-reference' || reference.type === 'tag-note';
  const raw = String(isTag ? (reference.label || reference.tagLabel || reference.tagId) : reference.type === 'span' ? (reference.text || reference.label || reference.nodeId) : (reference.label || reference.nodeId)).replace(/\s+/g, ' ').trim();
  const display = raw.length > 120 ? `${raw.slice(0, 117)}…` : raw;
  return `[${display.replace(/([\\\[\]])/g, '\\$1')}](${graphReferenceHref(reference)})`;
}

export function parseGraphReferenceHref(href) {
  const value = String(href || '');
  if (!value.startsWith('#')) return null;
  const query = new URLSearchParams(value.slice(1));
  const standaloneNoteId = query.get('graph-note');
  if (standaloneNoteId) {
    return { version: 1, kind: 'tag-note-reference', type: 'tag-note', noteId: standaloneNoteId };
  }
  const tagId = query.get('graph-tag');
  const referenceId = query.get('tag-ref');
  const instanceId = query.get('tag-instance');
  const noteId = query.get('tag-note');
  if (tagId && noteId && (referenceId || instanceId)) {
    return {
      version: 1,
      kind: 'tag-note-reference',
      type: 'tag-note',
      tagId,
      referenceId: referenceId || undefined,
      instanceId: instanceId || undefined,
      noteId,
    };
  }
  if (tagId && (referenceId || instanceId)) {
    return {
      version: 1,
      kind: 'tag-reference',
      type: 'tag',
      tagId,
      referenceId: referenceId || undefined,
      instanceId: instanceId || undefined,
    };
  }
  const nodeId = query.get('graph-node');
  if (!nodeId) return null;
  const number = (key) => {
    const raw = query.get(key);
    if (raw === null || raw === '') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  return {
    version: 1,
    kind: 'graph-reference',
    nodeId,
    type: ['span', 'pos'].includes(query.get('type')) ? query.get('type') : 'node',
    section: query.get('section') === 'proof' ? 'proof' : 'statement',
    start: number('start'),
    end: number('end'),
    x: number('x'),
    y: number('y'),
    offsetMode: query.get('offsetMode') || undefined,
  };
}
