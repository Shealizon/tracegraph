// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkspacePreviewController,
  isPreviewableWorkspaceFile,
  workspaceFileIcon,
  workspaceFileKind,
} from '../src/ui/workspacePreview.js';

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
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: vi.fn(() => 'blob:workspace-preview') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: vi.fn() });
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
    expect(isPreviewableWorkspaceFile({ path: 'figures/result.webp' })).toBe(true);
    expect(isPreviewableWorkspaceFile({ name: 'scan', type: 'image/png' })).toBe(true);
    expect(isPreviewableWorkspaceFile({ path: 'data.json' })).toBe(false);
  });

  it('assigns distinct icons to common file types', () => {
    const kinds = ['pdf', 'markdown', 'image', 'text', 'spreadsheet', 'document', 'presentation', 'archive', 'code', 'file'];
    expect(workspaceFileKind({ path: 'paper.pdf' })).toBe('pdf');
    expect(workspaceFileKind({ path: 'README.md' })).toBe('markdown');
    expect(workspaceFileKind({ path: 'figure.png' })).toBe('image');
    expect(workspaceFileKind({ path: 'table.xlsx' })).toBe('spreadsheet');
    expect(workspaceFileKind({ path: 'source.ts' })).toBe('code');
    expect(new Set(kinds.map((kind) => workspaceFileIcon(kind))).size).toBe(kinds.length);
    for (const kind of kinds) {
      const template = document.createElement('template');
      template.innerHTML = workspaceFileIcon(kind);
      const svg = template.content.firstElementChild;
      expect(svg?.tagName.toLowerCase(), kind).toBe('svg');
      expect(svg?.getAttribute('viewBox'), kind).toBe('0 0 24 24');
      expect(svg?.querySelectorAll('svg').length, kind).toBe(0);
      expect(svg?.outerHTML, kind).not.toMatch(/NaN|undefined|null/);
    }
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

  it('opens image files in a read-only image window and releases the object URL', async () => {
    const controller = createWorkspacePreviewController();
    const file = new File(['image'], 'figure.png', { type: 'image/png' });
    await controller.open({ file, path: 'uploads/figure.png', name: 'figure.png', conversationId: 'chat-1' });

    const preview = document.querySelector('.ai-image-file-preview');
    expect(preview?.getAttribute('role')).toBe('dialog');
    expect(preview?.textContent).toContain('图片 · Ctrl + 滚轮缩放 · 只读');
    expect(preview?.querySelector('img')?.src).toBe('blob:workspace-preview');
    expect(preview?.querySelector('[data-kind="image"]')).toBeTruthy();
    const image = preview.querySelector('img');
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 800 },
      naturalHeight: { configurable: true, value: 600 },
    });
    image.dispatchEvent(new Event('load'));
    const wheel = new WheelEvent('wheel', { ctrlKey: true, deltaY: -120, clientX: 20, clientY: 20, bubbles: true, cancelable: true });
    preview.querySelector('.ai-image-preview-body').dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(preview.querySelector('small').textContent).toMatch(/1[2-9]\d%/);
    controller.close();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:workspace-preview');
    expect(document.querySelector('.ai-image-file-preview')).toBeNull();
  });

  it('opens a paged PDF reader with text layer and window controls', async () => {
    const controller = createWorkspacePreviewController();
    const file = new File(['%PDF'], 'paper.pdf', { type: 'application/pdf' });
    await controller.open({ file, path: 'uploads/paper.pdf', name: 'paper.pdf', conversationId: 'chat-1' });

    const preview = document.querySelector('.ai-pdf-preview');
    expect(preview?.querySelector('[data-page-count]')?.textContent).toBe('3');
    expect(preview?.querySelector('.textLayer')?.textContent).toContain('Selectable PDF text');
    expect(preview?.querySelector('[data-window-smaller]')).toBeNull();
    expect(preview?.querySelector('[data-window-larger]')).toBeNull();
    expect(preview?.querySelector('.ai-pdf-resize-handle')).toBeNull();
    expect(preview?.querySelectorAll('[data-resize-edge]')).toHaveLength(8);

    Object.defineProperty(preview, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 100, top: 50, right: 600, bottom: 550, width: 500, height: 500 }),
    });
    preview.querySelector('[data-resize-edge="e"]').dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 600, clientY: 200, bubbles: true, cancelable: true }));
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 650, clientY: 200 }));
    window.dispatchEvent(new MouseEvent('pointerup'));
    expect(preview.style.width).toBe('550px');

    const wheel = new WheelEvent('wheel', { ctrlKey: true, deltaY: -120, clientX: 40, clientY: 40, bubbles: true, cancelable: true });
    preview.querySelector('.ai-pdf-stage').dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(preview.querySelector('[data-page-status]').textContent).toMatch(/1[2-9]\d%/);

    preview.querySelector('[data-next]').click();
    await vi.waitFor(() => expect(preview.querySelector('[data-page-status]').textContent).toContain('第 2 页'));
    controller.close();
    expect(pdf.destroy).toHaveBeenCalled();
  });
});
