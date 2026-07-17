/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeProject, compileProject } from '../src/project/projectAdapter.js';
import { buildModel } from '../src/model/graph.js';
import { openProjectConfigDialog } from '../src/project/projectConfig.js';
import { openNodeEditor } from '../src/ui/nodeEditor.js';

function project(allowNodeEditing = true) {
  return normalizeProject({
    id: 'project-ui', name: 'UI project', config: { enabledDocumentIds: ['doc'], allowNodeEditing },
    documents: [{ id: 'doc', name: 'Document', graph: {
      format: 'relation-graph@1', meta: { profile: 'generic', bodyFormat: 'markdown' },
      types: [{ id: 'idea', label: 'Idea' }],
      nodes: [{ id: 'a', type: 'idea', number: '1', title: 'Alpha', sections: [{ kind: 'statement', body: 'Body' }], anchors: [{ id: 'a' }], refs: [] }],
    } }],
  });
}

function context(allow = true) {
  const value = project(allow);
  return {
    project: value,
    nodeEditingEnabled: allow,
    model: buildModel(compileProject(value)),
    render: (source) => `<p>${source}</p>`,
    graph: { getTags: () => [] },
    persistNodeProject: vi.fn(async () => {}),
  };
}

describe('node editor surfaces', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

  it('does not open when node editing is disabled', () => {
    expect(openNodeEditor(context(false), 'a')).toBeNull();
    expect(document.querySelector('.node-editor')).toBeNull();
  });

  it('renders protected edit fields and the create-node form when enabled', () => {
    const ctx = context(true);
    const editor = openNodeEditor(ctx, 'a');
    expect(editor.querySelector('[data-id]').readOnly).toBe(true);
    expect(editor.querySelector('[data-title]').value).toBe('Alpha');
    expect(editor.querySelector('[data-delete]')).not.toBeNull();
    ctx._nodeEditorClose(true);

    const creator = openNodeEditor(ctx);
    expect(creator.querySelector('#node-editor-title').textContent).toBe('新增节点');
    expect(creator.querySelector('[data-id]').readOnly).toBe(false);
    expect(creator.querySelector('[data-delete]')).toBeNull();
    creator.querySelector('[data-add-ref]').click();
    expect(creator.querySelectorAll('.node-editor-ref')).toHaveLength(1);
    ctx._nodeEditorClose(true);
  });

  it('shows and persists the project-level node-editing switch', async () => {
    const value = project(true);
    const onSaved = vi.fn();
    const db = { transaction: vi.fn(() => ({
      objectStore: () => ({ put: () => {
        const request = {};
        queueMicrotask(() => { request.onsuccess?.(); });
        return request;
      } }),
    })) };
    const dialog = openProjectConfigDialog({ db, project: value, onSaved });
    const toggle = document.querySelector('[data-node-editing]');
    expect(toggle.checked).toBe(true);
    toggle.checked = false;
    document.querySelector('[data-save]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ allowNodeEditing: false }) }));
    expect(dialog).toBeUndefined();
  });
});
