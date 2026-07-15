import { describe, expect, it, vi } from 'vitest';
import {
  graphReferenceFromMember, graphReferenceHref, graphReferenceMarkdown,
  graphReferenceToMember, noteReferenceFromNote, parseGraphReferenceHref, resolveTagNoteReference,
  tagReferenceFromInstance,
} from '../src/data/graphReference.js';
import { normalizeTag, normalizeTags } from '../src/data/schema.js';
import { notePointerFromMember } from '../src/data/notes.js';
import { bindGraphReferencePaste, GRAPH_REFERENCE_MIME, setGraphReferenceClipboardData, writeGraphReference } from '../src/ui/graphClipboard.js';
import { contextPrompt, graphReferenceAttachment } from '../src/ai/contextAttachments.js';

const model = {
  meta: { profileResolved: { types: [{ id: 'idea', label: 'Idea' }] } },
  nodeById: new Map([['n1', { id: 'n1', type: 'idea', typeLabel: 'Idea', number: '3', title: 'A useful result' }]]),
};

describe('graph references and tag notes', () => {
  it('round-trips a text annotation through a Markdown graph link', () => {
    const member = { node: 'n1', type: 'span', section: 'proof', start: 12, end: 28, text: 'selected formula', offsetMode: 'visible' };
    const reference = graphReferenceFromMember(model, member);
    const parsed = parseGraphReferenceHref(graphReferenceHref(reference));
    expect(parsed).toMatchObject({ nodeId: 'n1', type: 'span', section: 'proof', start: 12, end: 28, offsetMode: 'visible' });
    expect(graphReferenceToMember({ ...parsed, text: reference.text })).toMatchObject(member);
    expect(graphReferenceMarkdown(reference)).toContain('[selected formula]');
  });

  it('does not invent numeric position fields for node references', () => {
    const parsed = parseGraphReferenceHref(graphReferenceHref(graphReferenceFromMember(model, 'n1')));
    expect(parsed.start).toBeUndefined();
    expect(parsed.x).toBeUndefined();
  });

  it('uses a dedicated stable tag-instance reference instead of a span reference', () => {
    const tag = normalizeTag({ id: 'review', label: 'Review', members: [
      { node: 'n1', type: 'span', section: 'statement', start: 2, end: 8, text: 'formula' },
    ] });
    const member = tag.members[0];
    const reference = tagReferenceFromInstance(model, tag, member);
    expect(reference).toMatchObject({ kind: 'tag-reference', type: 'tag', tagId: 'review', instanceId: member.instanceId, referenceId: member.referenceId });
    expect(graphReferenceHref(reference)).toContain('graph-tag=review');
    expect(graphReferenceHref(reference)).toContain(`tag-ref=${member.referenceId}`);
    expect(graphReferenceHref(reference)).not.toContain('start=');
    expect(graphReferenceMarkdown(reference)).toContain('[Review]');
    expect(graphReferenceMarkdown(reference)).not.toContain('#1');
    const parsed = parseGraphReferenceHref(graphReferenceHref(reference));
    expect(graphReferenceToMember(parsed, [tag])).toBe(member);
    expect(graphReferenceAttachment(model, reference, [tag])).toMatchObject({ kind: 'graph-tag', tagId: 'review', referenceId: member.referenceId });
    const reordered = normalizeTag({ ...tag, members: [{ node: 'n1', type: 'node', instanceId: 'other' }, member] });
    expect(reordered.members[1]).toMatchObject({ instanceId: member.instanceId, referenceId: member.referenceId });
  });

  it('suffixes duplicate text hashes so every tag reference id stays unique', () => {
    const tags = normalizeTags([
      { id: 'a', members: [{ node: 'n1', type: 'span', section: 'statement', start: 1, end: 4, text: 'same text' }] },
      { id: 'b', members: [{ node: 'n1', type: 'span', section: 'statement', start: 8, end: 11, text: 'same text' }] },
    ]);
    const first = tags[0].members[0].referenceId;
    const second = tags[1].members[0].referenceId;
    expect(first).toMatch(/^tr-[a-z0-9]+$/);
    expect(second).toBe(`${first}-2`);
  });

  it('writes rich graph clipboard data through a synchronous copy event without clipboard permission APIs', async () => {
    const originalDocument = globalThis.document;
    const originalNavigator = globalThis.navigator;
    const clipboardData = { values: {}, setData: vi.fn((type, value) => { clipboardData.values[type] = value; }) };
    let copyHandler = null;
    const clipboardWrite = vi.fn();
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { write: clipboardWrite } } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
      addEventListener: vi.fn((type, handler) => { if (type === 'copy') copyHandler = handler; }),
      removeEventListener: vi.fn(),
      execCommand: vi.fn(() => {
        copyHandler?.({ clipboardData, preventDefault: vi.fn() });
        return true;
      }),
    } });
    try {
      const copied = await writeGraphReference(graphReferenceFromMember(model, 'n1', 'copied text'));
      expect(copied).toBe(true);
      expect(clipboardWrite).not.toHaveBeenCalled();
      expect(clipboardData.values['text/plain']).toBe('copied text');
      expect(clipboardData.values['text/html']).toContain('data-paper-graph-reference');
      expect(JSON.parse(clipboardData.values[GRAPH_REFERENCE_MIME])).toMatchObject({ nodeId: 'n1' });
    } finally {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
    }
  });

  it('turns graph-reference paste into an AI attachment without inserting Markdown', () => {
    const handlers = {};
    const target = {
      value: '', selectionStart: 0, selectionEnd: 0,
      addEventListener: vi.fn((type, handler) => { handlers[type] = handler; }),
      removeEventListener: vi.fn(), setRangeText: vi.fn(), dispatchEvent: vi.fn(),
    };
    const values = {};
    const clipboardData = {
      setData: (type, value) => { values[type] = value; },
      getData: (type) => values[type] || '',
    };
    const reference = graphReferenceFromMember(model, 'n1', 'copied text');
    setGraphReferenceClipboardData(clipboardData, reference);
    const onReference = vi.fn();
    bindGraphReferencePaste(target, { insertMarkdown: false, onReference });
    const preventDefault = vi.fn();
    handlers.paste({ clipboardData, preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onReference).toHaveBeenCalledWith(reference);
    expect(target.setRangeText).not.toHaveBeenCalled();
    expect(target.value).toBe('');
  });

  it('keeps legacy embedded notes readable until project migration', () => {
    const tag = normalizeTag({ id: 't1', label: 'Tag', members: [{
      node: 'n1', type: 'span', section: 'statement', start: 2, end: 8,
      notes: [
        { id: 'a', title: 'First', content: '# one' },
        { id: 'b', title: 'Second', content: '[ref](#graph-node=n1)' },
      ],
    }] });
    expect(tag.members[0].notes).toHaveLength(2);
    expect(tag.members[0].instanceId).toMatch(/^ti-/);
    expect(tag.members[0].referenceId).toMatch(/^tr-/);
    expect(tag.members[0].notes[1]).toMatchObject({ id: 'b', title: 'Second', content: '[ref](#graph-node=n1)' });
  });

  it('round-trips a standalone stable note reference and creates a note-scoped AI attachment', () => {
    const tag = normalizeTag({ id: 'review', label: 'Review', members: [{
      node: 'n1', type: 'span', section: 'statement', start: 2, end: 8,
    }] });
    const member = tag.members[0];
    const note = { id: 'note-a', title: 'Observation', content: '**Important** detail', tagPointer: notePointerFromMember(tag, member) };
    const reference = noteReferenceFromNote(model, note, [tag]);
    const href = graphReferenceHref(reference);
    const parsed = parseGraphReferenceHref(href);

    expect(href).toBe('#graph-note=note-a');
    expect(parsed).toMatchObject({ kind: 'tag-note-reference', noteId: 'note-a' });
    expect(resolveTagNoteReference(parsed, [tag], [note])).toEqual({ tag, member, note });
    expect(graphReferenceMarkdown(reference)).toContain('[Observation]');
    const attachment = graphReferenceAttachment(model, parsed, [tag], [note]);
    expect(attachment).toMatchObject({
      kind: 'graph-tag-note', tagId: 'review', noteId: 'note-a', title: 'Observation', content: '**Important** detail',
    });
    expect(contextPrompt('Review this', [attachment], model)).toContain('<note_content>\n**Important** detail\n</note_content>');

    const archive = normalizeTag({ id: 'archive', label: 'Archive', members: [{ node: 'n1', type: 'node' }] });
    const movedNote = { ...note, tagPointer: notePointerFromMember(archive, archive.members[0]) };
    expect(resolveTagNoteReference(parsed, [tag, archive], [movedNote])).toMatchObject({ tag: { id: 'archive' }, note: { id: 'note-a' } });
  });
});
