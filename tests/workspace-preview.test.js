// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspacePreviewController, isPreviewableWorkspaceFile } from '../src/ui/workspacePreview.js';

const pdf = vi.hoisted(() => ({
  destroy: vi.fn(),
  render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
}));

vi.mock('../src/ai/pdf.js', () => ({
  openPdfDocument: vi.fn(async () => ({
    numPages: 3,
    destroy: pdf.destroy,
    getPage: async () => ({
      getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale, scale }),
      streamTextContent: () => ({}),
      render: pdf.render,
    }),
  })),
  createPdfTextLayer: vi.fn(({ container }) => ({
    cancel: vi.fn(),
    render: async () => {
      const span = document.createElement('span');
      span.textContent = 'Selectable PDF text';
      container.append(span);
    },
  })),
}));

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({}));
});

afterEach(() => {
  document.querySelectorAll('.ai-workspace-preview, .ai-pdf-preview, .ai-pdf-selection-actions').forEach((element) => element.remove());
  localStorage.clear();
});

describe('workspace file previews', () => {
  it('recognizes only the supported preview formats', () => {
    expect(isPreviewableWorkspaceFile({ path: 'paper.pdf' })).toBe(true);
    expect(isPreviewableWorkspaceFile({ path: 'notes/readme.md' })).toBe(true);
    expect(isPreviewableWorkspaceFile({ path: 'notes/plain.txt' })).toBe(true);
    expect(isPreviewableWorkspaceFile({ path: 'data.json' })).toBe(false);
  });

  it('opens TXT in a read-only note-style window', async () => {
    const controller = createWorkspacePreviewController();
    const file = new File(['line one\nline two'], 'notes.txt', { type: 'text/plain' });
    await controller.open({ file, path: 'uploads/notes.txt', name: 'notes.txt', conversationId: 'chat-1' });

    const preview = document.querySelector('.ai-text-file-preview');
    expect(preview?.getAttribute('role')).toBe('dialog');
    expect(preview?.textContent).toContain('纯文本 · 只读');
    expect(preview?.querySelector('pre')?.textContent).toBe('line one\nline two');
    expect(preview?.querySelector('textarea')).toBeNull();
    controller.close();
    expect(document.querySelector('.ai-text-file-preview')).toBeNull();
  });

  it('opens a paged PDF reader with text layer and window controls', async () => {
    const controller = createWorkspacePreviewController();
    const file = new File(['%PDF'], 'paper.pdf', { type: 'application/pdf' });
    await controller.open({ file, path: 'uploads/paper.pdf', name: 'paper.pdf', conversationId: 'chat-1' });

    const preview = document.querySelector('.ai-pdf-preview');
    expect(preview?.querySelector('[data-page-count]')?.textContent).toBe('3');
    expect(preview?.querySelector('.textLayer')?.textContent).toContain('Selectable PDF text');
    expect(preview?.querySelector('[data-window-smaller]')).toBeTruthy();
    expect(preview?.querySelector('[data-window-larger]')).toBeTruthy();
    expect(preview?.querySelector('.ai-pdf-resize-handle')).toBeTruthy();

    preview.querySelector('[data-next]').click();
    await vi.waitFor(() => expect(preview.querySelector('[data-page-status]').textContent).toContain('第 2 页'));
    controller.close();
    expect(pdf.destroy).toHaveBeenCalled();
  });
});
