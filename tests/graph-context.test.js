import { describe, expect, it, vi } from 'vitest';
import { buildModel } from '../src/model/graph.js';
import { buildGraphContext, executeGraphTool, graphToolDefinitions } from '../src/ai/graphContext.js';

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
});
