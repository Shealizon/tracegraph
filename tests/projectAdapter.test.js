import { describe, it, expect } from 'vitest';
import { normalizeProject, graphToDocument, compileProject, relationKey, uniqueId } from '../src/project/projectAdapter.js';

describe('projectAdapter · normalizeProject', () => {
  it('fills format/config defaults and doc fields', () => {
    const p = normalizeProject({ name: 'X', documents: [{ id: 'd1', graph: { nodes: [], edges: [] } }] });
    expect(p.format).toBe('paper-graph-project@1');
    expect(p.config.enabledDocumentIds).toEqual(['d1']);
    expect(p.documents[0].sourceType).toBe('structured-json');
  });
});

describe('projectAdapter · graphToDocument', () => {
  it('uses graph title and generates id', () => {
    const d = graphToDocument({ meta: { title: 'My' }, nodes: [], edges: [] }, 'f.json');
    expect(d.name).toBe('My');
    expect(d.sourceType).toBe('structured-json');
    expect(d.id).toMatch(/^doc-/);
  });
});

describe('projectAdapter · helpers', () => {
  it('relationKey / uniqueId', () => {
    expect(relationKey('a', 'l', 'b')).toBe('a|l|b');
    expect(uniqueId('doc')).toMatch(/^doc-/);
    expect(uniqueId('p')).not.toBe(uniqueId('p'));
  });
});

describe('projectAdapter · compileProject', () => {
  const proj = {
    id: 'p', name: 'P',
    config: { enabledDocumentIds: ['d1'], disabledNodeIds: ['x'], disabledRelationKeys: [] },
    documents: [{
      id: 'd1', name: 'D1',
      graph: {
        meta: {},
        nodes: [
          { id: 'a', type: 'theorem', labels: [{ id: 'a' }], refs: [{ cmd: 'ref', target: 'b', where: 'statement' }] },
          { id: 'b', type: 'lemma', labels: [{ id: 'b' }], refs: [] },
          { id: 'x', type: 'lemma', labels: [{ id: 'x' }], refs: [] },
        ],
        edges: [],
      },
    }],
  };
  const c = compileProject(proj);
  it('drops disabled nodes', () => {
    const ids = c.nodes.map((n) => n.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids).not.toContain('x');
  });
  it('resolves refs into cross-node edges', () => {
    expect(c.edges).toContainEqual(expect.objectContaining({ from: 'b', fromLabel: 'b', to: 'a' }));
  });
  it('only enabled documents are compiled', () => {
    expect(c.meta.counts.statements).toBe(2);
  });
});

describe('projectAdapter · compileProject 跨文档重复 id', () => {
  const mkDoc = (id, tag) => ({
    id, name: 'Doc' + tag,
    graph: {
      meta: {},
      nodes: [
        { id: 'method:training', type: 'theorem', labels: [{ id: 'method:training' }], refs: [] },
        { id: 'result:r1', type: 'lemma', labels: [{ id: 'result:r1' }], refs: [{ cmd: 'ref', target: 'method:training', where: 'statement' }] },
      ],
      edges: [],
    },
  });
  const proj = {
    id: 'p2', name: 'P2',
    config: { enabledDocumentIds: ['dA', 'dB'], disabledNodeIds: [], disabledRelationKeys: [] },
    documents: [mkDoc('dA', 'A'), mkDoc('dB', 'B')],
  };
  const c = compileProject(proj);

  it('每个节点 id 全局唯一（不被覆盖）', () => {
    const ids = c.nodes.map((n) => n.id);
    expect(ids.length).toBe(4);
    expect(new Set(ids).size).toBe(4);
    expect(ids.filter((x) => x === 'method:training').length).toBe(1); // 仅一个保留原 id
  });
  it('每篇内部引用仍解析为各自文档内的边', () => {
    expect(c.edges.length).toBe(2);
    // 每条边的 from/to 都来自同一文档（不串文档）
    for (const e of c.edges) {
      const from = c.nodes.find((n) => n.id === e.from);
      const to = c.nodes.find((n) => n.id === e.to);
      expect(from.documentId).toBe(to.documentId);
      expect(e.fromLabel).toBe(e.from); // fromLabel 跟随唯一化后的节点 id
    }
  });
});
