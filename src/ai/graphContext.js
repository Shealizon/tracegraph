const BODY_LIMIT = 18000;
const BATCH_NODE_LIMIT = 12;
const BATCH_BODY_LIMIT = 60000;

export function buildGraphContext(model, selectedNodeId = '') {
  if (!model?.nodes?.length) return '';
  const types = countBy(model.nodes, (node) => node.typeLabel || node.type || '其他');
  const important = [...model.nodes].sort((a, b) => (b.importance || 0) - (a.importance || 0)).slice(0, 8).map(nodeSummary);
  const selected = selectedNodeId ? model.nodeById.get(selectedNodeId) : null;
  return `当前图谱概览（仅为轻量索引，需要细节时调用 graph_* 工具）：\n${JSON.stringify({
    title: model.meta?.title || '', nodes: model.nodes.length, edges: model.edges.length,
    labels: model.labelIndex?.size || 0, types, important_nodes: important,
    selected_node: selected ? nodeSummary(selected) : null,
  })}`;
}

export function graphToolDefinitions() {
  return [
    tool('graph_overview', '读取当前图谱的轻量概览、类型分布和重要节点。', { type: 'object', properties: {}, additionalProperties: false }),
    tool('search_graph_nodes', '按 ID、标题、编号或正文关键词搜索图谱节点。只返回摘要，不返回完整正文。', {
      type: 'object', required: ['query'], additionalProperties: false,
      properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 30 } },
    }),
    tool('get_graph_node', '按需读取一个图谱节点。detail=summary 仅返回元数据，content 返回正文，full 还返回标签与引用。', {
      type: 'object', required: ['node_id'], additionalProperties: false,
      properties: { node_id: { type: 'string' }, detail: { type: 'string', enum: ['summary', 'content', 'full'] } },
    }),
    tool('get_graph_nodes', '批量读取多个已知图谱节点。已知多个 node_id 时优先使用本工具，一次最多读取 12 个节点；detail=summary 仅返回元数据，content 返回正文，full 还返回标签与引用。', {
      type: 'object', required: ['node_ids'], additionalProperties: false,
      properties: {
        node_ids: { type: 'array', minItems: 1, maxItems: BATCH_NODE_LIMIT, items: { type: 'string' }, description: '需要一起读取的节点 ID 列表' },
        detail: { type: 'string', enum: ['summary', 'content', 'full'] },
        max_chars: { type: 'integer', minimum: 2000, maximum: 80000, description: '批量正文总字符上限，默认 60000' },
      },
    }),
    tool('get_graph_neighbors', '读取节点的直接依赖（references）、直接使用者（cited_by）或两者。', {
      type: 'object', required: ['node_id'], additionalProperties: false,
      properties: { node_id: { type: 'string' }, direction: { type: 'string', enum: ['references', 'cited_by', 'both'] } },
    }),
    tool('get_graph_neighbors_batch', '批量读取多个已知节点的直接关系。已知多个 node_id 时优先使用本工具，一次最多读取 12 个节点；direction 可选 references、cited_by 或 both。', {
      type: 'object', required: ['node_ids'], additionalProperties: false,
      properties: {
        node_ids: { type: 'array', minItems: 1, maxItems: BATCH_NODE_LIMIT, items: { type: 'string' }, description: '需要一起读取关系的节点 ID 列表' },
        direction: { type: 'string', enum: ['references', 'cited_by', 'both'] },
      },
    }),
    tool('locate_graph_reference', '定位节点正文中的标签或引用文本，返回 section、字符位置和上下文片段。', {
      type: 'object', required: ['node_id'], additionalProperties: false,
      properties: { node_id: { type: 'string' }, label_id: { type: 'string' }, ref_target: { type: 'string' }, query: { type: 'string' } },
    }),
    tool('focus_graph_node', '在图谱界面打开指定节点；提供 label_id 时滚动到相应标签。', {
      type: 'object', required: ['node_id'], additionalProperties: false,
      properties: { node_id: { type: 'string' }, label_id: { type: 'string' } },
    }),
  ];
}

export async function executeGraphTool(model, name, args, hooks = {}) {
  if (name === 'graph_overview') return JSON.parse(buildGraphContext(model).replace(/^.*?：\n/s, ''));
  if (name === 'search_graph_nodes') return searchNodes(model, args);
  if (name === 'get_graph_node') return getNode(model, args);
  if (name === 'get_graph_nodes') return getNodes(model, args);
  if (name === 'get_graph_neighbors') return getNeighbors(model, args);
  if (name === 'get_graph_neighbors_batch') return getNeighborsBatch(model, args);
  if (name === 'locate_graph_reference') return locateReference(model, args);
  if (name === 'focus_graph_node') {
    const node = requireNode(model, args.node_id);
    await hooks.revealGraphNode?.(node, args.label_id || '');
    return { opened: true, node: nodeSummary(node), label_id: args.label_id || null };
  }
  return null;
}

export function isGraphTool(name) { return name.startsWith('graph_') || ['search_graph_nodes', 'get_graph_node', 'get_graph_nodes', 'get_graph_neighbors', 'get_graph_neighbors_batch', 'locate_graph_reference', 'focus_graph_node'].includes(name); }

function searchNodes(model, args) {
  const query = String(args.query || '').trim().toLowerCase();
  if (!query) throw new Error('搜索词不能为空');
  const limit = clamp(args.limit, 1, 30, 12);
  const scored = [];
  for (const node of model.nodes) {
    const head = `${node.id} ${node.number || ''} ${node.title || ''} ${node.typeLabel || node.type || ''}`.toLowerCase();
    const body = `${node.statementBody || ''}\n${node.proofBody || ''}`.toLowerCase();
    const score = head === query ? 100 : head.includes(query) ? 20 : body.includes(query) ? 5 : 0;
    if (score) scored.push({ score: score + Math.min(4, node.importance || 0) / 10, node });
  }
  scored.sort((a, b) => b.score - a.score);
  return { query: args.query, results: scored.slice(0, limit).map(({ node }) => ({ ...nodeSummary(node), excerpt: matchingExcerpt(node, query) })) };
}

function getNode(model, args) {
  const node = requireNode(model, args.node_id);
  const detail = args.detail || 'summary';
  const result = nodeSummary(node);
  if (detail === 'content' || detail === 'full') {
    result.sections = node.sections?.length
      ? node.sections.map((section) => ({ kind: section.kind, label: section.label || '', body: truncate(section.body, BODY_LIMIT) }))
      : [{ kind: 'statement', body: truncate(node.statementBody, BODY_LIMIT) }, ...(node.proofBody ? [{ kind: 'proof', body: truncate(node.proofBody, BODY_LIMIT) }] : [])];
  }
  if (detail === 'full') {
    result.labels = (node.labels || []).map(({ id, kind, number }) => ({ id, kind, number }));
    result.refs = (node.refs || []).map(({ id, target, targetNode, relation, cmd, where, internal, resolved }) => ({ id, target, targetNode, relation: relation || cmd, where, internal, resolved }));
  }
  return result;
}

function getNodes(model, args) {
  const ids = [...new Set(Array.isArray(args.node_ids) ? args.node_ids.map((id) => String(id || '').trim()).filter(Boolean) : [])];
  if (!ids.length) throw new Error('请提供至少一个 node_id');
  if (ids.length > BATCH_NODE_LIMIT) throw new Error(`一次最多读取 ${BATCH_NODE_LIMIT} 个图谱节点`);
  const detail = args.detail || 'summary';
  const maxChars = clamp(args.max_chars, 2000, 80000, BATCH_BODY_LIMIT);
  let remaining = maxChars;
  const nodes = [];
  const missing = [];
  const truncated = [];
  for (const id of ids) {
    const node = model?.nodeById?.get(id);
    if (!node) { missing.push(id); continue; }
    const result = getNode(model, { node_id: id, detail });
    if (result.sections?.length) {
      const before = JSON.stringify(result).length;
      result.sections = limitSections(result.sections, Math.max(800, remaining));
      const after = JSON.stringify(result).length;
      if (after < before || result.sections.some((section) => String(section.body || '').includes('…（已截断）'))) truncated.push(id);
      remaining = Math.max(0, remaining - after);
    }
    nodes.push(result);
  }
  return { detail, requested: ids, nodes, missing, truncated, max_chars: maxChars };
}

function limitSections(sections, limit) {
  let remaining = limit;
  return sections.map((section) => {
    const body = String(section.body || '');
    const allowed = Math.max(400, Math.min(body.length, remaining));
    const next = { ...section, body: truncate(body, allowed) };
    remaining = Math.max(0, remaining - next.body.length);
    return next;
  });
}

function getNeighbors(model, args) {
  const node = requireNode(model, args.node_id);
  const direction = args.direction || 'both';
  return neighborsForNode(model, node, direction);
}

function getNeighborsBatch(model, args) {
  const ids = [...new Set(Array.isArray(args.node_ids) ? args.node_ids.map((id) => String(id || '').trim()).filter(Boolean) : [])];
  if (!ids.length) throw new Error('请提供至少一个 node_id');
  if (ids.length > BATCH_NODE_LIMIT) throw new Error(`一次最多读取 ${BATCH_NODE_LIMIT} 个节点关系`);
  const direction = args.direction || 'both';
  const nodes = [];
  const missing = [];
  for (const id of ids) {
    const node = model?.nodeById?.get(id);
    if (!node) { missing.push(id); continue; }
    nodes.push(neighborsForNode(model, node, direction));
  }
  return { direction, requested: ids, nodes, missing };
}

function neighborsForNode(model, node, direction) {
  return {
    node: nodeSummary(node),
    ...(direction !== 'cited_by' ? { references: [...(model.deps.get(node.id) || [])].map((id) => nodeSummary(model.nodeById.get(id))) } : {}),
    ...(direction !== 'references' ? { cited_by: [...(model.usedBy.get(node.id) || [])].map((id) => nodeSummary(model.nodeById.get(id))) } : {}),
  };
}

function locateReference(model, args) {
  const node = requireNode(model, args.node_id);
  const needles = [args.label_id, args.ref_target, args.query].map((item) => String(item || '').trim()).filter(Boolean);
  if (!needles.length) throw new Error('请提供 label_id、ref_target 或 query');
  const sections = node.sections?.length ? node.sections : [
    { kind: 'statement', body: node.statementBody || '' }, { kind: 'proof', body: node.proofBody || '' },
  ];
  const matches = [];
  for (const section of sections) {
    for (const needle of needles) {
      const lower = String(section.body || '').toLowerCase();
      let from = 0;
      while (matches.length < 30) {
        const index = lower.indexOf(needle.toLowerCase(), from);
        if (index < 0) break;
        matches.push({ section: section.kind, query: needle, start: index, end: index + needle.length, excerpt: excerpt(section.body, index, needle.length) });
        from = index + Math.max(1, needle.length);
      }
    }
  }
  return {
    node: nodeSummary(node), matches,
    labels: (node.labels || []).filter((label) => needles.includes(label.id)).map(({ id, kind, number }) => ({ id, kind, number })),
    refs: (node.refs || []).filter((ref) => needles.includes(ref.target) || needles.includes(ref.id)).map(({ id, target, targetNode, where, relation, cmd }) => ({ id, target, targetNode, where, relation: relation || cmd })),
  };
}

function nodeSummary(node) {
  if (!node) return null;
  return { id: node.id, type: node.typeLabel || node.type || '', number: node.number || '', title: node.title || '', importance: node.importance || 0, references: node.degIn || 0, cited_by: node.degOut || 0 };
}
function requireNode(model, id) { const node = model?.nodeById?.get(String(id || '')); if (!node) throw new Error(`找不到图谱节点：${id}`); return node; }
function matchingExcerpt(node, query) { const body = `${node.statementBody || ''}\n${node.proofBody || ''}`; const index = body.toLowerCase().indexOf(query); return index < 0 ? '' : excerpt(body, index, query.length); }
function excerpt(text, index, length) { return String(text || '').slice(Math.max(0, index - 120), index + length + 220).replace(/\s+/g, ' ').trim(); }
function truncate(text, limit) { const value = String(text || ''); return value.length > limit ? `${value.slice(0, limit)}\n…（已截断）` : value; }
function countBy(items, keyOf) { return Object.fromEntries([...items.reduce((map, item) => map.set(keyOf(item), (map.get(keyOf(item)) || 0) + 1), new Map())]); }
function clamp(value, min, max, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback; }
function tool(name, description, parameters) { return { type: 'function', function: { name, description, parameters } }; }
