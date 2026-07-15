import { memberInstanceId, memberKey, memberReferenceId } from './schema.js';

export function noteDisplayTitle(note) {
  if (String(note?.title || '').trim()) return note.title.trim();
  const first = String(note?.content || '').replace(/^#+\s*/gm, '').split(/\n/).find((line) => line.trim());
  return first ? `${first.trim().slice(0, 34)}${first.trim().length > 34 ? '…' : ''}` : '未命名笔记';
}

export function notePointerFromMember(tag, member) {
  if (!tag?.id || !member) return null;
  return {
    tagId: tag.id,
    instanceId: memberInstanceId(member) || memberKey(member),
    referenceId: memberReferenceId(member) || '',
  };
}

export function resolveNotePointer(noteOrPointer, tags = []) {
  const pointer = noteOrPointer?.tagPointer === undefined ? noteOrPointer : noteOrPointer.tagPointer;
  if (!pointer?.tagId) return null;
  const tag = (tags || []).find((item) => item.id === pointer.tagId);
  if (!tag) return null;
  const member = (tag.members || []).find((item) => {
    if (pointer.referenceId && memberReferenceId(item) === pointer.referenceId) return true;
    if (pointer.instanceId && (memberInstanceId(item) === pointer.instanceId || memberKey(item) === pointer.instanceId)) return true;
    return false;
  });
  return member ? { tag, member } : null;
}

export function notesForMember(notes, tag, member) {
  const pointer = notePointerFromMember(tag, member);
  if (!pointer) return [];
  return (notes || []).filter((note) => {
    const own = note.tagPointer;
    if (!own || own.tagId !== pointer.tagId) return false;
    if (own.referenceId && pointer.referenceId) return own.referenceId === pointer.referenceId;
    return own.instanceId === pointer.instanceId;
  });
}

export function floatingNotes(notes) {
  return (notes || []).filter((note) => !note.tagPointer);
}

export function normalizeNote(note, tags = [], index = 0) {
  const createdAt = note?.createdAt || new Date(0).toISOString();
  const rawPointer = note?.tagPointer || note?.tagRef || null;
  const pointer = rawPointer && resolveNotePointer(rawPointer, tags) ? {
    tagId: String(rawPointer.tagId),
    instanceId: String(rawPointer.instanceId || ''),
    referenceId: String(rawPointer.referenceId || ''),
  } : null;
  return {
    id: String(note?.id || `note-${index + 1}`),
    title: typeof note?.title === 'string' ? note.title : '',
    content: typeof note?.content === 'string' ? note.content : '',
    tagPointer: pointer,
    createdAt,
    updatedAt: note?.updatedAt || createdAt,
  };
}

export function normalizeProjectNotes(rawNotes, tags = []) {
  const out = [];
  const used = new Set();
  const push = (raw, pointer = undefined) => {
    if (!raw || typeof raw !== 'object') return;
    const baseId = String(raw.id || `note-${out.length + 1}`);
    let id = baseId; let suffix = 2;
    while (used.has(id)) id = `${baseId}-${suffix++}`;
    used.add(id);
    out.push(normalizeNote({ ...raw, id, ...(pointer !== undefined ? { tagPointer: pointer } : {}) }, tags, out.length));
  };
  for (const note of Array.isArray(rawNotes) ? rawNotes : []) push(note);
  for (const tag of tags || []) {
    for (const member of tag.members || []) {
      const pointer = notePointerFromMember(tag, member);
      for (const note of Array.isArray(member?.notes) ? member.notes : []) {
        // A previously migrated project can briefly contain both forms while
        // an older tab is saving. Prefer the standalone copy by id.
        if ((rawNotes || []).some((item) => item?.id && item.id === note.id)) continue;
        push(note, pointer);
      }
    }
  }
  return out;
}

export function stripEmbeddedNotes(tags = []) {
  return (tags || []).map((tag) => ({
    ...tag,
    members: (tag.members || []).map((member) => {
      if (!member || typeof member === 'string') return member;
      const { notes: _legacyNotes, ...clean } = member;
      return clean;
    }),
  }));
}

export function upsertNote(notes, note, tags = []) {
  const normalized = normalizeNote(note, tags, (notes || []).length);
  const index = (notes || []).findIndex((item) => item.id === normalized.id);
  if (index < 0) return [...(notes || []), normalized];
  const next = [...notes]; next[index] = normalized; return next;
}

export function removeNote(notes, noteId) {
  return (notes || []).filter((note) => note.id !== noteId);
}

export function reassignNotesFromMember(notes, tag, member, nextPointer) {
  const ids = new Set(notesForMember(notes, tag, member).map((note) => note.id));
  return (notes || []).map((note) => ids.has(note.id) ? { ...note, tagPointer: nextPointer || null, updatedAt: new Date().toISOString() } : note);
}
