import { describe, it, expect } from 'vitest';
import { isGenericSchema, compileGraph } from '../src/data/adapter.js';

describe('adapter · isGenericSchema', () => {
  it('detects generic vs runtime', () => {
    expect(isGenericSchema({ format: 'relation-graph@1' })).toBe(true);
    expect(isGenericSchema({ nodes: [{ sections: [] }] })).toBe(true);
    expect(isGenericSchema({ nodes: [{ anchors: [] }] })).toBe(true);
    expect(isGenericSchema({ nodes: [{ statementBody: 'x', labels: [] }] })).toBe(false);
    expect(isGenericSchema(null)).toBe(false);
  });
});

describe('adapter · compileGraph runtime passthrough', () => {
  it('keeps nodes and attaches resolved profile', () => {
    const rt = { meta: { title: 'T' }, nodes: [{ id: 'a', type: 'theorem', labels: [{ id: 'a' }], refs: [] }], edges: [] };
    const c = compileGraph(rt);
    expect(c.nodes.length).toBe(1);
    expect(c.meta.profileResolved.id).toBe('paper');
  });
});

describe('adapter · compileGeneric', () => {
  const gen = {
    format: 'relation-graph@1',
    meta: { title: 'G' },
    types: [{ id: 'primary', label: 'P' }, { id: 'src', label: 'S', leaf: true }],
    nodes: [
      { id: 'n1', type: 'primary', number: '1', sections: [{ kind: 'statement', body: 'uses \\ref{n2}' }], anchors: [{ id: 'n1' }], refs: [{ target: 'n2', relation: 'ref' }] },
      { id: 'n2', type: 'primary', number: '2', sections: [{ kind: 'statement', body: 'b' }], anchors: [{ id: 'n2' }], refs: [{ target: 'n1', relation: 'ref', internal: true }] },
    ],
  };
  const c = compileGraph(gen);
  it('maps sections to statementBody and type label', () => {
    const n1 = c.nodes.find((n) => n.id === 'n1');
    expect(n1.statementBody).toBe('uses \\ref{n2}');
    expect(n1.typeLabel).toBe('P');
  });
  it('derives cross-node edges, skips internal refs', () => {
    expect(c.edges).toContainEqual(expect.objectContaining({ from: 'n2', fromLabel: 'n2', to: 'n1' }));
    expect(c.edges.some((e) => e.to === 'n2')).toBe(false); // n2's ref to n1 marked internal
  });
  it('computes counts', () => {
    expect(c.meta.counts.statements).toBe(2);
    expect(c.meta.counts.edges).toBe(1);
  });
});
