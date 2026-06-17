import { describe, it, expect } from 'vitest';
import { detectTheoremEnvs, extractGenericTexGraph } from '../src/import/texGeneric.js';

describe('texGeneric · detectTheoremEnvs', () => {
  it('parses \\newtheorem declarations (incl. starred)', () => {
    const m = detectTheoremEnvs('\\newtheorem{thm}{Theorem}\\newtheorem*{rmk}{Remark}');
    expect(m).toEqual({ thm: 'Theorem', rmk: 'Remark' });
  });
  it('handles optional counter argument', () => {
    const m = detectTheoremEnvs('\\newtheorem{cor}[thm]{Corollary}');
    expect(m.cor).toBe('Corollary');
  });
});

describe('texGeneric · extractGenericTexGraph', () => {
  it('auto-detects common environments present in body', () => {
    const tex = '\\begin{document}\\begin{corollary}\\label{c}X \\ref{t}.\\end{corollary}\\begin{theorem}\\label{t}Y.\\end{theorem}\\end{document}';
    const g = extractGenericTexGraph(tex);
    expect(g.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['c', 't']));
    const cor = g.nodes.find((n) => n.id === 'c');
    expect(cor.type).toBe('corollary');
    expect(cor.typeLabel).toBe('Corollary');
    expect(g.edges).toContainEqual({ from: 't', fromLabel: 't', to: 'c' });
  });
  it('uses \\newtheorem printed names', () => {
    const tex = '\\newtheorem{conj}{Conjecture}\\begin{document}\\begin{conj}\\label{x}Z.\\end{conj}\\end{document}';
    const g = extractGenericTexGraph(tex);
    expect(g.nodes[0].type).toBe('conj');
    expect(g.nodes[0].typeLabel).toBe('Conjecture');
  });
  it('falls back to no nodes when nothing matches', () => {
    const g = extractGenericTexGraph('\\begin{document}plain text, no envs\\end{document}');
    expect(g.nodes.length).toBe(0);
  });
});
