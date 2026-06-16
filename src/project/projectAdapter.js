import { compileGraph } from '../data/adapter.js';

export const PROJECT_FORMAT = 'paper-graph-project@1';

export function createDemoProject(rawGraph) {
  const now = new Date().toISOString();
  return {
    format: PROJECT_FORMAT,
    id: 'project-hardy-demo',
    name: 'Hardy 唯一延拓性样例项目',
    createdAt: now,
    updatedAt: now,
    config: {
      enabledDocumentIds: ['doc-hardy'],
      disabledNodeIds: [],
      disabledRelationKeys: [],
      viewState: {},
    },
    documents: [
      {
        id: 'doc-hardy',
        name: rawGraph?.meta?.title || 'Hardy 论文样例',
        sourceType: 'structured-json',
        importedAt: now,
        graph: rawGraph,
      },
    ],
  };
}

export function normalizeProject(project) {
  const now = new Date().toISOString();
  const docs = Array.isArray(project?.documents) ? project.documents : [];
  const enabled = project?.config?.enabledDocumentIds?.length ? project.config.enabledDocumentIds : docs.map((d) => d.id);
  return {
    format: PROJECT_FORMAT,
    id: project?.id || `project-${Date.now()}`,
    name: project?.name || '未命名项目',
    createdAt: project?.createdAt || now,
    updatedAt: project?.updatedAt || now,
    config: {
      enabledDocumentIds: enabled,
      disabledNodeIds: project?.config?.disabledNodeIds || [],
      disabledRelationKeys: project?.config?.disabledRelationKeys || [],
      viewState: project?.config?.viewState || {},
    },
    documents: docs.map((doc, i) => ({
      id: doc.id || `doc-${i + 1}`,
      name: doc.name || `文档 ${i + 1}`,
      sourceType: doc.sourceType || 'structured-json',
      importedAt: doc.importedAt || now,
      graph: doc.graph || { meta: { title: doc.name || `文档 ${i + 1}` }, nodes: [], edges: [] },
    })),
  };
}

export function graphToDocument(graph, name, sourceType = 'structured-json') {
  const title = graph?.meta?.title || name || '导入文档';
  return {
    id: uniqueId('doc'),
    name: title,
    sourceType,
    importedAt: new Date().toISOString(),
    graph,
  };
}

export function compileProject(project) {
  const normalized = normalizeProject(project);
  const enabledDocs = new Set(normalized.config.enabledDocumentIds || []);
  const disabledNodes = new Set(normalized.config.disabledNodeIds || []);
  const disabledRelations = new Set(normalized.config.disabledRelationKeys || []);
  const docs = normalized.documents.filter((doc) => enabledDocs.has(doc.id));
  const nodes = [];
  const labelOwner = new Map();

  for (const doc of docs) {
    const compiled = compileGraph(doc.graph);
    for (const rawNode of compiled.nodes || []) {
      if (disabledNodes.has(rawNode.id)) continue;
      const node = {
        ...rawNode,
        documentId: doc.id,
        documentName: doc.name,
        labels: (rawNode.labels || []).map((l) => ({ ...l })),
        refs: (rawNode.refs || []).map((r) => ({ ...r })),
      };
      nodes.push(node);
      for (const label of node.labels) {
        if (!labelOwner.has(label.id)) labelOwner.set(label.id, { node, label });
      }
    }
  }

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edges = [];
  const seen = new Set();
  for (const node of nodes) {
    for (const ref of node.refs || []) {
      const owner = labelOwner.get(ref.target);
      if (!owner || !nodeById.has(owner.node.id)) {
        ref.resolved = false;
        ref.targetNode = ref.targetNode || null;
        continue;
      }
      ref.resolved = true;
      ref.targetNode = owner.node.id;
      ref.internal = owner.node.id === node.id;
      if (ref.internal) continue;
      const key = relationKey(owner.node.id, ref.target, node.id);
      if (disabledRelations.has(key) || seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: owner.node.id, fromLabel: ref.target, to: node.id, relation: ref.relation || ref.cmd || 'ref' });
    }
  }

  const firstGraph = docs[0] ? compileGraph(docs[0].graph) : { meta: {} };
  return {
    meta: {
      ...(firstGraph.meta || {}),
      title: normalized.name,
      source: 'project',
      projectId: normalized.id,
      projectName: normalized.name,
      documents: docs.map((d) => ({ id: d.id, name: d.name, sourceType: d.sourceType })),
      counts: {
        statements: nodes.filter((n) => n.type !== 'bib').length,
        bib: nodes.filter((n) => n.type === 'bib').length,
        edges: edges.length,
        labels: nodes.reduce((sum, n) => sum + (n.labels?.length || 0), 0),
      },
    },
    nodes,
    edges,
  };
}

export function relationKey(from, fromLabel, to) {
  return `${from}|${fromLabel}|${to}`;
}

export function uniqueId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
