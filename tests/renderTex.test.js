import { describe, it, expect } from 'vitest';
import { createRenderer } from '../src/render/tex.js';

describe('render/tex · math environments', () => {
  it('renders multline through a KaTeX-supported wrapper', () => {
    const render = createRenderer({
      macros: { '\\Rn': '\\mathbb R^n', '\\e': '\\epsilon' },
      numberOf: () => '2.1',
      kindOf: () => 'equation',
    });
    const html = render(String.raw`
\begin{multline}\label{eq:x}
\eta_\e \|e^{(a(t)-\e)|x|^2}\nabla u\|_{L^2(\Rn)}\\
\le N\|u(0)\|_{L^2(\Rn)}.
\end{multline}`);
    expect(html).not.toContain('math-error');
    expect(html).not.toContain('\\begin{multline}');
    expect(html).toContain('katex-display');
  });

  it('renders equation numbers with KaTeX leqno tags', () => {
    const render = createRenderer({
      numberOf: () => '57',
      kindOf: () => 'equation',
    });
    const html = render(String.raw`\[
a_{k+1}=\frac{a_k}{1-a_kb_k},\qquad c_{k+1}=(c_k^2-b_k)\label{eq:long}
\]`);
    expect(html).toContain('katex-display leqno');
    expect(html).toContain('class="tag"');
    expect(html).toContain('57');
  });
});
