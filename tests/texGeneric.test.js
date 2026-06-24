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
  it('adds labeled equations outside theorem blocks and resolves eqrefs', () => {
    const tex = `
      \\begin{document}
      \\begin{equation}\\label{eq:outside} x=1 \\end{equation}
      \\begin{theorem}\\label{thm:a}Use \\eqref{eq:outside}.\\end{theorem}
      \\end{document}`;
    const g = extractGenericTexGraph(tex);
    const eq = g.nodes.find((n) => n.id === 'eq:outside');
    expect(eq.type).toBe('equation');
    expect(g.edges).toContainEqual(expect.objectContaining({ from: 'eq:outside', fromLabel: 'eq:outside', to: 'thm:a' }));
    expect(g.nodes.flatMap((n) => n.refs || []).filter((r) => !r.resolved)).toEqual([]);
  });
  it('reads bibliography from tex when no aux is supplied', () => {
    const tex = `
      \\begin{document}
      \\begin{theorem}\\label{thm:a}Use \\cite[pp. 1]{ref1}.\\end{theorem}
      \\begin{thebibliography}{9}
      \\bibitem{ref1} A. Author, \\emph{Paper}.
      \\end{thebibliography}
      \\end{document}`;
    const g = extractGenericTexGraph(tex);
    const bib = g.nodes.find((n) => n.id === 'ref1');
    expect(bib.type).toBe('bib');
    expect(bib.number).toBe('1');
    expect(g.edges).toContainEqual(expect.objectContaining({ from: 'ref1', fromLabel: 'ref1', to: 'thm:a' }));
  });
  it('routes titled proof environments to referenced statements', () => {
    const tex = `
      \\begin{document}
      \\begin{theorem}\\label{thm:a}A.\\end{theorem}
      \\begin{lemma}\\label{lem:b}B.\\end{lemma}
      \\begin{proof}[Proof of Theorem \\ref{thm:a}]Proof for A.\\end{proof}
      \\end{document}`;
    const g = extractGenericTexGraph(tex);
    expect(g.nodes.find((n) => n.id === 'thm:a').proofBody).toContain('Proof for A');
    expect(g.nodes.find((n) => n.id === 'lem:b').proofBody).toBe('');
  });
});
