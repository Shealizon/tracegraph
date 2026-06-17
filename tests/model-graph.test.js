import { describe, it, expect } from 'vitest';
import { buildModel, dependencyCone } from '../src/model/graph.js';

const node = (id) => ({ id, type: 'theorem', labels: [{ id }], refs: [] });

// 链：a <- b <- c （边方向 from 被 to 使用：a被b用，b被c用）
const chain = {
  meta: {},
  nodes: [node('a'), node('b'), node('c')],
  edges: [{ from: 'a', fromLabel: 'a', to: 'b' }, { from: 'b', fromLabel: 'b', to: 'c' }],
};

describe('model · buildModel (acyclic chain)', () => {
  const m = buildModel(chain);
  it('builds adjacency (usedBy / deps)', () => {
    expect([...m.usedBy.get('a')]).toEqual(['b']);
    expect([...m.deps.get('c')]).toEqual(['b']);
    expect(m.labelIndex.get('a').node.id).toBe('a');
  });
  it('computes importance recursively', () => {
    expect(m.nodeById.get('a').importance).toBe(1);
    expect(m.nodeById.get('b').importance).toBe(2);
    expect(m.nodeById.get('c').importance).toBe(2);
    expect(m.maxImportance).toBe(2);
  });
  it('no cycle, radii assigned', () => {
    expect(m.hasCycle).toBe(false);
    expect(m.nodeById.get('a').radius).toBeGreaterThan(0);
  });
  it('dependencyCone walks all upstream deps', () => {
    expect([...dependencyCone(m, 'c')].sort()).toEqual(['a', 'b']);
  });
});

describe('model · buildModel (cycle)', () => {
  const cyc = {
    meta: {},
    nodes: [node('a'), node('b')],
    edges: [{ from: 'a', fromLabel: 'a', to: 'b' }, { from: 'b', fromLabel: 'b', to: 'a' }],
  };
  const m = buildModel(cyc);
  it('detects SCC cycle', () => {
    expect(m.hasCycle).toBe(true);
    expect(m.nodeById.get('a').inCycle).toBe(true);
    expect(m.nodeById.get('b').inCycle).toBe(true);
  });
  it('cycle importance uses total degree', () => {
    expect(m.nodeById.get('a').importance).toBe(2);
  });
});

describe('model · leaf radius', () => {
  it('bib leaf gets fixed small radius', () => {
    const m = buildModel({ meta: {}, nodes: [{ id: 'r', type: 'bib', labels: [{ id: 'r' }], refs: [] }], edges: [] });
    expect(m.nodeById.get('r').radius).toBe(24);
  });
});
