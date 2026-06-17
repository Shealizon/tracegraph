import { describe, it, expect } from 'vitest';
import { extractFixedTexGraph } from '../src/import/texExtract.js';

const TEX = `\\begin{document}
\\begin{theorem}[Main]\\label{thm:a}
Statement uses \\eqref{eq:1}.
\\begin{equation}\\label{eq:1} x=1 \\end{equation}
\\end{theorem}
\\begin{proof} By \\ref{lem:b} and \\cite{ref1}. \\end{proof}
\\begin{lemma}\\label{lem:b}
Lemma body.
\\end{lemma}
\\end{document}`;

describe('texExtract · extractFixedTexGraph (fixed paper)', () => {
  const g = extractFixedTexGraph(TEX);
  it('extracts statement nodes with type/title/auto-number', () => {
    const thm = g.nodes.find((n) => n.id === 'thm:a');
    const lem = g.nodes.find((n) => n.id === 'lem:b');
    expect(thm.type).toBe('theorem');
    expect(thm.typeLabel).toBe('Theorem');
    expect(thm.title).toBe('Main');
    expect(thm.number).toBe('1');
    expect(lem.type).toBe('lemma');
    expect(lem.number).toBe('2');
  });
  it('owns equation labels inside its blocks', () => {
    const thm = g.nodes.find((n) => n.id === 'thm:a');
    expect(thm.labels.map((l) => l.id)).toEqual(expect.arrayContaining(['thm:a', 'eq:1']));
  });
  it('creates cross-node edge, skips internal eqref and unresolved cite', () => {
    expect(g.edges).toEqual([{ from: 'lem:b', fromLabel: 'lem:b', to: 'thm:a' }]);
  });
  it('reports counts', () => {
    expect(g.meta.counts.statements).toBe(2);
  });
});

describe('texExtract · aux numbering + bib', () => {
  it('prefers .aux number over auto', () => {
    const g = extractFixedTexGraph(
      '\\begin{document}\\begin{theorem}\\label{thm:a}X.\\end{theorem}\\end{document}',
      '\\newlabel{thm:a}{{7}{1}{Main}{theorem.7}{}}',
    );
    expect(g.nodes[0].number).toBe('7');
  });
  it('creates bib leaf node and cite edge from \\bibcite', () => {
    const g = extractFixedTexGraph(
      '\\begin{document}\\begin{theorem}\\label{t}Use \\cite{ref1}.\\end{theorem}\\end{document}',
      '\\bibcite{ref1}{12}',
    );
    const bib = g.nodes.find((n) => n.type === 'bib');
    expect(bib.id).toBe('ref1');
    expect(bib.number).toBe('12');
    expect(g.edges).toContainEqual({ from: 'ref1', fromLabel: 'ref1', to: 't' });
  });
});

describe('texExtract · custom environments', () => {
  it('honors opts.envs / typeLabels', () => {
    const tex = '\\begin{document}\\begin{claim}\\label{c1}A \\ref{c2}.\\end{claim}\\begin{claim}\\label{c2}B.\\end{claim}\\end{document}';
    const g = extractFixedTexGraph(tex, '', { envs: ['claim'], typeLabels: { claim: 'Claim' } });
    expect(g.nodes.length).toBe(2);
    expect(g.nodes[0].typeLabel).toBe('Claim');
    expect(g.edges).toEqual([{ from: 'c2', fromLabel: 'c2', to: 'c1' }]);
  });
});
