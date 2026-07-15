import { describe, expect, it } from 'vitest';
import { normalizeTags } from '../src/data/schema.js';
import {
  floatingNotes, normalizeProjectNotes, notePointerFromMember, notesForMember,
  reassignNotesFromMember, removeNote, stripEmbeddedNotes, upsertNote,
} from '../src/data/notes.js';

describe('standalone notes', () => {
  it('migrates legacy member notes once and strips nested storage', () => {
    const tags = normalizeTags([{ id: 'tag', members: [{ node: 'n1', type: 'span', start: 1, end: 3, notes: [{ id: 'a', content: 'Legacy' }] }] }]);
    const notes = normalizeProjectNotes([], tags);
    expect(notes[0]).toMatchObject({ id: 'a', content: 'Legacy', tagPointer: { tagId: 'tag' } });
    expect(stripEmbeddedNotes(tags)[0].members[0].notes).toBeUndefined();
  });

  it('associates notes with an exact tag instance rather than a tag group', () => {
    const tags = normalizeTags([{ id: 'tag', members: [{ node: 'n1', type: 'node' }, { node: 'n2', type: 'node' }] }]);
    const note = { id: 'a', title: '', content: 'One', tagPointer: notePointerFromMember(tags[0], tags[0].members[1]) };
    expect(notesForMember([note], tags[0], tags[0].members[0])).toEqual([]);
    expect(notesForMember([note], tags[0], tags[0].members[1])).toEqual([note]);
  });

  it('supports floating, reassignment, upsert, and independent deletion', () => {
    const tags = normalizeTags([{ id: 'tag', members: [{ node: 'n1', type: 'span', start: 1, end: 3 }, { node: 'n1', type: 'node' }] }]);
    const span = tags[0].members[0]; const node = tags[0].members[1];
    let notes = upsertNote([], { id: 'a', content: 'A', tagPointer: notePointerFromMember(tags[0], span) }, tags);
    notes = reassignNotesFromMember(notes, tags[0], span, notePointerFromMember(tags[0], node));
    expect(notesForMember(notes, tags[0], node)).toHaveLength(1);
    notes = upsertNote(notes, { id: 'free', content: 'Free', tagPointer: null }, tags);
    expect(floatingNotes(notes).map((note) => note.id)).toEqual(['free']);
    expect(removeNote(notes, 'a').map((note) => note.id)).toEqual(['free']);
  });
});
