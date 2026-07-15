/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeTags } from '../src/data/schema.js';
import { notePointerFromMember, notesForMember } from '../src/data/notes.js';
import { buildMemberNotes, highlightSidebarNote, openNoteEditor } from '../src/ui/sidebar.js';

describe('standalone note editor', () => {
  let tags; let notes; let ctx;

  beforeEach(() => {
    vi.useFakeTimers(); document.body.innerHTML = '';
    tags = normalizeTags([
      { id: 'source', label: 'Source', members: [{ node: 'n1', type: 'span', start: 2, end: 8 }] },
      { id: 'target', label: 'Target', members: [{ node: 'n2', type: 'node' }] },
    ]);
    notes = [{ id: 'note-a', title: 'Original', content: 'Body', tagPointer: notePointerFromMember(tags[0], tags[0].members[0]), createdAt: '2025-01-01', updatedAt: '2025-01-01' }];
    ctx = {
      graph: { getTags: () => tags }, getNotes: () => notes,
      persistNotes: vi.fn((next) => { notes = next; }),
      notesForMember: (tag, member) => notesForMember(notes, tag, member),
      model: { meta: {}, labelIndex: new Map(), nodeById: new Map([['n1', { id: 'n1', title: 'Source node' }], ['n2', { id: 'n2', title: 'Target node' }]]) },
      aiPanel: { attachNote: vi.fn(() => true) }, jumpToMember: vi.fn(),
      noteWindows: {
        close: vi.fn(), applySize: vi.fn((el) => { el.style.width = '380px'; el.style.height = '440px'; }),
        position: vi.fn(), clampPosition: vi.fn(), observeSize: vi.fn(() => vi.fn()), saveSize: vi.fn(), lastPosition: null,
      },
    };
    ctx.openNoteEditor = (noteId, options) => openNoteEditor(ctx, noteId, options);
  });

  afterEach(() => { ctx?._tagNoteEditorClose?.(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('auto-saves, reassigns to an exact instance, previews, and rolls back', () => {
    const editor = openNoteEditor(ctx, 'note-a');
    const title = editor.querySelector('.tag-note-title-input');
    const textarea = editor.querySelector('.tag-note-textarea');
    expect(title.placeholder).toBe('');
    expect(editor.querySelector('.tag-note-identity small')).toBeNull();
    expect(editor.querySelector('.tag-note-identity').textContent).not.toContain('文本标注');
    title.value = 'Changed'; textarea.value = 'Changed body';
    textarea.dispatchEvent(new Event('input', { bubbles: true })); vi.advanceTimersByTime(400);
    expect(notes[0]).toMatchObject({ title: 'Changed', content: 'Changed body' });

    editor.querySelector('.tag-note-identity').click();
    [...editor.querySelectorAll('.tag-note-instance-option')].find((button) => button.textContent.includes('Target node')).click();
    expect(notes[0].tagPointer).toMatchObject({ tagId: 'target', instanceId: tags[1].members[0].instanceId });

    editor.querySelector('[title="预览"]').click();
    expect(editor.dataset.mode).toBe('preview');
    expect(editor.querySelector('.tag-note-preview').style.display).toBe('block');
    expect(editor.querySelector('.tag-note-preview-content').textContent).toContain('Changed body');

    editor.querySelector('[title="回到打开时的状态"]').click();
    expect(notes[0]).toMatchObject({ title: 'Original', content: 'Body', tagPointer: { tagId: 'source' } });
    expect(title.value).toBe('Original'); expect(textarea.value).toBe('Body');
  });

  it('uses the same shared row actions in the sidebar and leaves row clicks inert', () => {
    ctx.openNoteEditor = vi.fn();
    const section = buildMemberNotes(ctx, tags[0], tags[0].members[0], tags[0].members[0].instanceId);
    const row = section.querySelector('.note-ui-row');
    row.click(); expect(ctx.openNoteEditor).not.toHaveBeenCalled();
    row.querySelector('[title="引用到 AI"]').click();
    expect(ctx.aiPanel.attachNote).toHaveBeenCalledWith(notes[0]);
    row.querySelector('[title="编辑笔记"]').click();
    expect(ctx.openNoteEditor).toHaveBeenCalledWith('note-a', expect.any(Object));
  });

  it('copies all content and attaches the independent note to AI', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText } });
    const editor = openNoteEditor(ctx, 'note-a');
    editor.querySelector('[title="复制所有内容"]').click();
    editor.querySelector('[title="引用到 AI"]').click();
    await Promise.resolve(); await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith('Original\n\nBody');
    expect(ctx.aiPanel.attachNote).toHaveBeenCalledWith(expect.objectContaining({ id: 'note-a' }));
  });

  it('creates a titleless floating note and flushes it on close', () => {
    const editor = openNoteEditor(ctx, '', { tagPointer: null });
    const textarea = editor.querySelector('.tag-note-textarea');
    textarea.value = 'A title is optional'; textarea.dispatchEvent(new Event('input', { bubbles: true }));
    editor.querySelector('[title="关闭"]').click();
    expect(notes.at(-1)).toMatchObject({ title: '', content: 'A title is optional', tagPointer: null });
    expect(document.querySelector('.tag-note-editor')).toBeNull();
  });

  it('locates and highlights a newly created sidebar note', () => {
    const root = document.createElement('aside');
    const first = document.createElement('div'); first.className = 'note-ui-row'; first.dataset.noteId = 'first';
    const added = document.createElement('div'); added.className = 'note-ui-row'; added.dataset.noteId = 'added';
    root.append(first, added);
    expect(highlightSidebarNote(root, 'added')).toBe(added);
    expect(added.classList.contains('is-note-revealed')).toBe(true);
    expect(first.classList.contains('is-note-revealed')).toBe(false);
  });
});
