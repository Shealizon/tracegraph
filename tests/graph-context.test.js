import { describe, expect, it, vi } from 'vitest';
import { buildModel } from '../src/model/graph.js';
import { buildGraphContext, executeGraphTool, graphToolDefinitions } from '../src/ai/graphContext.js';
import { memberKey, normalizeTags } from '../src/data/schema.js';
import { notePointerFromMember } from '../src/data/notes.js';

function graph() {
  return buildModel({
    format: 'relation-graph@1',
    meta: { title: 'Test graph' },
    types: [{ id: 'idea', label: '概念' }],
    nodes: [
      { id: 'a', type: 'idea', title: '基础结论', sections: [{ kind: 'statement', body: 'Base statement \\label{eq:base}' }], anchors: [{ id: 'eq:base' }] },
      { id: 'b', type: 'idea', title: '应用结论', sections: [{ kind: 'statement', body: 'Uses equation \\ref{eq:base} here.' }], anchors: [{ id: 'b' }], refs: [{ id: 'r1', target: 'eq:base', where: 'statement' }] },
    ],
  });
}

describe('progressive graph context', () => {
  it('puts only a compact overview and selected node summary in the system context', () => {
    const context = buildGraphContext(graph(), 'b');
    expect(context).toContain('Test graph');
    expect(context).toContain('selected_node');
    expect(context).not.toContain('Uses equation');
  });

  it('exposes graph tools and reads node relationships on demand', async () => {
    const model = graph();
    expect(graphToolDefinitions().map((item) => item.function.name)).toContain('get_graph_neighbors');
    const result = await executeGraphTool(model, 'get_graph_neighbors', { node_id: 'b', direction: 'references' });
    expect(result.references.map((node) => node.id)).toEqual(['a']);
  });

  it('reads multiple graph nodes in one bounded call', async () => {
    const model = graph();
    const names = graphToolDefinitions().map((item) => item.function.name);
    expect(names).toContain('get_graph_nodes');
    const result = await executeGraphTool(model, 'get_graph_nodes', { node_ids: ['a', 'b'], detail: 'content' });
    expect(result.nodes.map((node) => node.id)).toEqual(['a', 'b']);
    expect(result.nodes[0].sections[0].body).toContain('Base statement');
    expect(result.missing).toEqual([]);
  });

  it('reads relationships for multiple graph nodes in one bounded call', async () => {
    const model = graph();
    const names = graphToolDefinitions().map((item) => item.function.name);
    expect(names).toContain('get_graph_neighbors_batch');
    const result = await executeGraphTool(model, 'get_graph_neighbors_batch', { node_ids: ['b', 'a'], direction: 'references' });
    expect(result.nodes.map(({ node }) => node.id)).toEqual(['b', 'a']);
    expect(result.nodes[0].references.map((node) => node.id)).toEqual(['a']);
    expect(result.nodes[1].references).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it('locates ref text with section and character offsets', async () => {
    const result = await executeGraphTool(graph(), 'locate_graph_reference', { node_id: 'b', ref_target: 'eq:base' });
    expect(result.matches[0]).toMatchObject({ section: 'statement', query: 'eq:base' });
    expect(result.refs[0]).toMatchObject({ id: 'r1', targetNode: 'a' });
  });

  it('can reveal a graph node through a UI hook', async () => {
    const revealGraphNode = vi.fn();
    const result = await executeGraphTool(graph(), 'focus_graph_node', { node_id: 'a', label_id: 'eq:base' }, { revealGraphNode });
    expect(result.opened).toBe(true);
    expect(revealGraphNode).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'eq:base');
  });

  it('lets AI create, read, update, and delete tag notes through confirmed hooks', async () => {
    const tags = normalizeTags([{ id: 'tag-1', label: 'Review', members: ['a', { node: 'b', type: 'node' }] }]);
    let notes = [{ id: 'other', title: 'Other', content: 'Keep me', tagPointer: notePointerFromMember(tags[0], tags[0].members[1]), createdAt: '2025-01-01', updatedAt: '2025-01-01' }];
    const hooks = {
      getGraphTags: () => tags,
      getGraphNotes: () => notes,
      persistGraphNotes: vi.fn((next) => { notes = next; }),
      confirmTagNoteChange: vi.fn(async () => true),
    };
    const sourceKey = memberKey(tags[0].members[0]);
    const created = await executeGraphTool(graph(), 'create_tag_note', { tag_id: 'tag-1', member_key: sourceKey, title: 'Check', content: '**Markdown**' }, hooks);
    const noteId = created.note.id;
    expect(notes.find((note) => note.id === noteId).content).toBe('**Markdown**');
    expect(notes.find((note) => note.id === 'other').content).toBe('Keep me');
    const read = await executeGraphTool(graph(), 'get_tag_note', { tag_id: 'tag-1', member_key: sourceKey, note_id: noteId }, hooks);
    expect(read.note.title).toBe('Check');
    await executeGraphTool(graph(), 'update_tag_note', { tag_id: 'tag-1', member_key: sourceKey, note_id: noteId, content: 'Updated' }, hooks);
    expect(notes.find((note) => note.id === noteId).content).toBe('Updated');
    const listed = await executeGraphTool(graph(), 'list_tag_notes', { tag_id: 'tag-1' }, hooks);
    expect(listed.tags[0].members[0].notes).toHaveLength(1);
    await executeGraphTool(graph(), 'delete_tag_note', { tag_id: 'tag-1', member_key: sourceKey, note_id: noteId }, hooks);
    expect(notes.some((note) => note.id === noteId)).toBe(false);
    expect(notes.find((note) => note.id === 'other')).toBeTruthy();
  });
});
