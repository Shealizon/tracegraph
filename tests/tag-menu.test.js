/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModalManager } from '../src/view/modal.js';
import { normalizeTag } from '../src/data/schema.js';
import { notePointerFromMember, notesForMember } from '../src/data/notes.js';
import { createNoteWindowController } from '../src/ui/noteUi.js';

describe('tag annotation note menu', () => {
  afterEach(() => {
    document.querySelectorAll('.m-menu, .tag-note-hover-preview').forEach((element) => element.remove());
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  function managerWith(noteCount = 1) {
    const tag = normalizeTag({ id: 'tag', kind: 'unordered', label: 'Review', members: [{ node: 'n1', type: 'span', start: 1, end: 4 }] });
    const member = tag.members[0];
    const notes = Array.from({ length: noteCount }, (_, index) => ({
      id: `note-${index}`, title: index ? `Note ${index + 1}` : 'First', content: '**Preview**',
      tagPointer: notePointerFromMember(tag, member),
    }));
    const manager = Object.create(ModalManager.prototype);
    manager.ctx = {
      graph: { _attachChipGesture: null, getTags: () => [tag] },
      model: { meta: {}, labelIndex: new Map() },
      getNotes: () => notes,
      notesForMember: (targetTag, targetMember) => notesForMember(notes, targetTag, targetMember),
      openNoteEditor: vi.fn(), requestDeleteTagMember: vi.fn(), persistNotes: vi.fn(),
      aiPanel: { attachNote: vi.fn(() => true) },
    };
    manager.ctx.noteWindows = createNoteWindowController(manager.ctx);
    return { manager, tag, member, notes };
  }

  it('shows the attached standalone note count on a mark chip', () => {
    const { manager, tag, member } = managerWith(2);
    const chip = manager._markChip(tag, '', member);
    expect(chip.querySelector('.m-mark-note-count')?.textContent).toBe('2');
  });

  it('shows shared note actions, hover preview, inert row clicks, and keeps delete last', () => {
    vi.useFakeTimers();
    const { manager, tag, member, notes } = managerWith(1);
    const anchor = document.createElement('button'); document.body.appendChild(anchor);
    manager._openMarkChipMenu(anchor, tag, member);

    const menu = document.querySelector('.m-menu');
    expect(menu.lastElementChild.classList.contains('danger')).toBe(true);
    expect(menu.lastElementChild.textContent).toContain('删除该标注');
    expect(menu.querySelector('.note-heading').textContent).toContain('笔记 · 1');
    const row = menu.querySelector('.menu-note-row');
    expect(row.querySelectorAll('.note-ui-action')).toHaveLength(3);
    row.click();
    expect(manager.ctx.openNoteEditor).not.toHaveBeenCalled();

    row.dispatchEvent(new Event('pointerenter'));
    const preview = document.querySelector('.tag-note-hover-preview');
    expect(preview?.textContent).toContain('Preview');
    expect(preview.querySelectorAll('.note-resize-handle')).toHaveLength(8);
    row.querySelector('[title="引用到 AI"]').click();
    expect(manager.ctx.aiPanel.attachNote).toHaveBeenCalledWith(notes[0]);
    row.querySelector('[title="编辑笔记"]').click();
    expect(manager.ctx.openNoteEditor).toHaveBeenCalledWith(notes[0].id, expect.objectContaining({ anchor: row }));
  });

  it('opens a new note attached to the exact tag instance', () => {
    const { manager, tag, member } = managerWith(0);
    const anchor = document.createElement('button'); document.body.appendChild(anchor);
    manager._openMarkChipMenu(anchor, tag, member);
    document.querySelector('.note-heading .mm-action').click();
    expect(manager.ctx.openNoteEditor).toHaveBeenCalledWith('', expect.objectContaining({
      tagPointer: expect.objectContaining({ tagId: tag.id, instanceId: member.instanceId }),
    }));
  });

  it('disables hover previews and window resizing in the compact touch layout', () => {
    vi.stubGlobal('matchMedia', vi.fn((query) => ({ matches: query.includes('max-width: 760px') })));
    const { manager, tag, member } = managerWith(1);
    const anchor = document.createElement('button'); document.body.appendChild(anchor);
    manager._openMarkChipMenu(anchor, tag, member);

    const row = document.querySelector('.menu-note-row');
    row.dispatchEvent(new Event('pointerenter'));
    expect(document.querySelector('.tag-note-hover-preview')).toBeNull();

    const panel = document.createElement('section');
    panel.style.width = '380px'; panel.style.height = '440px';
    manager.ctx.noteWindows.applySize(panel);
    const disconnect = manager.ctx.noteWindows.attachEdgeResize(panel);
    expect(panel.style.width).toBe('');
    expect(panel.style.height).toBe('');
    expect(panel.querySelectorAll('.note-resize-handle')).toHaveLength(0);
    disconnect();
  });
});
