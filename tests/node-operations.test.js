import { describe, expect, it } from 'vitest';
import { compileProject, normalizeProject } from '../src/project/projectAdapter.js';
import {
  createProjectNode, deleteProjectNode, nodeDraftFromProject, updateProjectNode, validateNodeDraft,
} from '../src/project/nodeOperations.js';

function genericProject() {
  return normalizeProject({
    id: 'project-test', name: 'Test', config: { enabledDocumentIds: ['doc-a'], allowNodeEditing: true },
    documents: [{
      id: 'doc-a', name: 'A', graph: {
        format: 'relation-graph@1', meta: { profile: 'generic', bodyFormat: 'markdown' },
        types: [{ id: 'idea', label: 'Idea' }],
        nodes: [
          { id: 'a', type: 'idea', title: 'A', sections: [{ kind: 'statement', body: 'Alpha' }], anchors: [{ id: 'a' }], refs: [] },
          { id: 'b', type: 'idea', title: 'B', sections: [{ kind: 'statement', body: 'Uses A' }], anchors: [{ id: 'b' }], refs: [{ id: 'r1', target: 'a', relation: 'ref', where: 'statement' }] },
        ],
      },
    }],
  });
}

describe('node project operations', () => {
  it('preserves the project-level edit switch and source node identity', () => {
    const project = genericProject();
    expect(project.config.allowNodeEditing).toBe(true);
    const compiled = compileProject(project);
    expect(compiled.nodes.find((node) => node.id === 'a')).toMatchObject({ sourceNodeId: 'a', documentId: 'doc-a' });
    expect(normalizeProject({ id: 'x', documents: [] }).config.allowNodeEditing).toBe(false);
  });

  it('creates and updates generic nodes without mutating the original project', () => {
    const project = genericProject();
    const created = createProjectNode(project, {
      documentId: 'doc-a', id: 'c', type: 'idea', number: '3', title: 'C',
      statementBody: 'Gamma', proofBody: 'Details', refs: [{ key: 'r2', target: 'a', relation: 'ref', where: 'statement' }],
    });
    expect(project.documents[0].graph.nodes).toHaveLength(2);
    expect(created.documents[0].graph.nodes.at(-1)).toMatchObject({
      id: 'c', sections: [{ kind: 'statement', body: 'Gamma' }, { kind: 'proof', body: 'Details' }],
      anchors: [{ id: 'c' }], refs: [{ target: 'a', relation: 'ref' }],
    });

    const runtime = compileProject(created).nodes.find((node) => node.id === 'c');
    const draft = nodeDraftFromProject(created, runtime);
    const updated = updateProjectNode(created, 'doc-a', 'c', { ...draft, title: 'Changed', statementBody: 'Changed body', proofBody: '' });
    const raw = updated.documents[0].graph.nodes.find((node) => node.id === 'c');
    expect(raw.title).toBe('Changed');
    expect(raw.sections).toEqual([{ kind: 'statement', body: 'Changed body' }]);
  });

  it('deletes a node, its incoming structured references, and tag membership', () => {
    const project = genericProject();
    project.config.tags = [{ id: 'tag-a', label: 'A', members: [{ node: 'a', type: 'node', instanceId: 'member-a' }] }];
    project.config.notes = [{ id: 'note-a', content: 'note', title: '', tagPointer: { tagId: 'tag-a', instanceId: 'member-a' } }];
    const deleted = deleteProjectNode(project, 'doc-a', 'a', 'a');
    expect(deleted.documents[0].graph.nodes.map((node) => node.id)).toEqual(['b']);
    expect(deleted.documents[0].graph.nodes[0].refs).toEqual([]);
    expect(deleted.config.tags[0].members).toEqual([]);
    expect(normalizeProject(deleted).config.notes[0].tagPointer).toBeNull();
  });

  it('supports the legacy runtime schema and keeps its edge list in sync', () => {
    const project = normalizeProject({
      id: 'legacy', config: { enabledDocumentIds: ['doc'] }, documents: [{ id: 'doc', name: 'Legacy', graph: {
        meta: {}, edges: [], nodes: [{ id: 'a', type: 'theorem', title: 'A', number: '1', statementBody: 'A', proofBody: '', labels: [{ id: 'a', kind: 'theorem', number: '1' }], refs: [] }],
      } }],
    });
    const created = createProjectNode(project, {
      documentId: 'doc', id: 'b', type: 'lemma', number: '2', title: 'B', statementBody: 'B', proofBody: '',
      refs: [{ key: 'r1', target: 'a', relation: 'ref', where: 'statement' }],
    });
    expect(created.documents[0].graph.nodes[1]).toMatchObject({ statementBody: 'B', labels: [{ id: 'b' }], refs: [{ cmd: 'ref' }] });
    expect(created.documents[0].graph.edges).toEqual([{ from: 'a', fromLabel: 'a', to: 'b', relation: 'ref' }]);
  });

  it('validates required and immutable-identity inputs for creation', () => {
    const project = genericProject();
    expect(validateNodeDraft(project, { documentId: 'doc-a', id: 'a', type: 'idea', refs: [] }, { creating: true })).toContain('节点 ID「a」已存在');
    expect(validateNodeDraft(project, { documentId: 'doc-a', id: 'bad id', type: '', refs: [{ target: '' }] }, { creating: true })).toEqual(expect.arrayContaining([
      '节点 ID 不能包含空格', '请选择节点类型', '引用目标不能为空',
    ]));
  });
});
