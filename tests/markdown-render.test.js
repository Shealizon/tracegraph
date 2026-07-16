/** @vitest-environment jsdom */

import { describe, expect, it } from 'vitest';
import { formatUnresolvedFileReference, renderMarkdownInto } from '../src/render/markdown.js';

describe('AI Markdown references', () => {
  it('keeps confirmed graph labels clickable', () => {
    const root = document.createElement('div');
    const entry = {
      node: { id: 'thm:conditional', typeLabel: 'Theorem', number: '1', title: 'Sharp uniqueness' },
      label: { id: 'thm:conditional', kind: 'theorem', number: '1' },
    };
    renderMarkdownInto(root, String.raw`结论见 \ref{thm:conditional}。`, {
      graphLabels: new Map([['thm:conditional', entry]]),
    });

    expect(root.querySelector('.ai-graph-ref')?.textContent).toBe('Theorem 1');
    expect(root.textContent).not.toContain(String.raw`\ref{`);
  });

  it('degrades PDF-only LaTeX labels to readable non-clickable references', () => {
    const root = document.createElement('div');
    renderMarkdownInto(root, String.raw`参见 \ref{thm:conditional}、\ref{lem:gauge} 与 \eqref{eq:threshold}。`);

    expect([...root.querySelectorAll('.ai-file-ref')].map((item) => item.textContent)).toEqual([
      '定理「conditional」', '引理「gauge」', '公式「threshold」',
    ]);
    expect(root.querySelector('.ai-graph-ref')).toBeNull();
    expect(root.textContent).not.toContain(String.raw`\ref{`);
    expect(root.textContent).not.toContain(String.raw`\eqref{`);
  });

  it('does not rewrite file references inside code', () => {
    const root = document.createElement('div');
    renderMarkdownInto(root, '正文 \\ref{thm:a}，代码 `\\ref{thm:b}`。');

    expect(root.querySelector('.ai-file-ref')?.textContent).toBe('定理「a」');
    expect(root.querySelector('code')?.textContent).toBe(String.raw`\ref{thm:b}`);
  });

  it('formats common uploaded-file label prefixes', () => {
    expect(formatUnresolvedFileReference('ref', 'prop:main-result')).toBe('命题「main result」');
    expect(formatUnresolvedFileReference('eqref', 'energy')).toBe('公式「energy」');
  });
});
