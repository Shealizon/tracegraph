// =============================================================================
// data/schema.js  —  通用关系结构的 profile 定义
//
// profile 决定“皮肤”：有哪些节点类型、各自颜色/标签/是否为叶子，以及引用关系的
// 默认编号格式。适配器(adapter.js)据此把通用数据编译成运行时格式，UI 文案与配色
// 也由 profile 提供，从而与具体领域解耦。
//
// 一个 profile 形如：
//   {
//     id, label,
//     bodyFormat: 'latex' | 'markdown' | 'text',
//     defaultType, defaultRelation,
//     statementKinds: ['statement', ...],  // 主体正文 section.kind 候选
//     proofKinds:     ['proof', ...],       // 折叠正文 section.kind 候选
//     types:     [ { id, label, color, leaf?, order? } ],
//     relations: [ { id, label, numbering } ],   // numbering: '(n)'|'[n]'|'n'
//   }
// =============================================================================

// 论文 profile：复刻当前数学论文皮肤（theorem/proposition/lemma/bib）。
const PAPER_PROFILE = {
  id: 'paper',
  label: '学术论文',
  bodyFormat: 'latex',
  defaultType: 'theorem',
  defaultRelation: 'ref',
  statementKinds: ['statement'],
  proofKinds: ['proof'],
  types: [
    { id: 'theorem', label: 'Theorem', color: '#ff9e64', order: 0 },
    { id: 'proposition', label: 'Proposition', color: '#c39bff', order: 1 },
    { id: 'lemma', label: 'Lemma', color: '#7dd3a8', order: 2 },
    { id: 'bib', label: 'Reference', color: '#8a8a98', leaf: true, order: 3 },
  ],
  relations: [
    { id: 'ref', label: '引用', numbering: 'n' },
    { id: 'eqref', label: '公式引用', numbering: '(n)' },
    { id: 'cite', label: '文献引用', numbering: '[n]' },
  ],
};

// 通用 profile：领域无关的默认皮肤（节点 / 子项 / 来源）。
const GENERIC_PROFILE = {
  id: 'generic',
  label: '通用关系图',
  bodyFormat: 'markdown',
  defaultType: 'node',
  defaultRelation: 'ref',
  statementKinds: ['statement', 'summary', 'body', 'main'],
  proofKinds: ['proof', 'detail', 'details', 'note'],
  types: [
    { id: 'primary', label: '主节点', color: '#7c9cff', order: 0 },
    { id: 'node', label: '节点', color: '#7dd3a8', order: 1 },
    { id: 'support', label: '支撑', color: '#c39bff', order: 2 },
    { id: 'source', label: '来源', color: '#8a8a98', leaf: true, order: 3 },
  ],
  relations: [
    { id: 'ref', label: '引用', numbering: 'n' },
    { id: 'cite', label: '来源引用', numbering: '[n]' },
  ],
};

export const PROFILES = {
  paper: PAPER_PROFILE,
  generic: GENERIC_PROFILE,
};

export const DEFAULT_PROFILE = PAPER_PROFILE;

// 把 profile 规整为带索引、可直接消费的形态。
export function mergeProfile(p) {
  const base = p || DEFAULT_PROFILE;
  const types = (base.types || DEFAULT_PROFILE.types).slice().sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  const typeById = Object.fromEntries(types.map((t) => [t.id, t]));
  const relations = base.relations || DEFAULT_PROFILE.relations;
  const relationById = Object.fromEntries(relations.map((r) => [r.id, r]));
  return {
    id: base.id || 'custom',
    label: base.label || base.id || 'custom',
    bodyFormat: base.bodyFormat || 'latex',
    defaultType: base.defaultType || types[0]?.id || 'node',
    defaultRelation: base.defaultRelation || relations[0]?.id || 'ref',
    statementKinds: base.statementKinds || ['statement'],
    proofKinds: base.proofKinds || ['proof'],
    types,
    typeById,
    relations,
    relationById,
  };
}

// 按 numbering 模板格式化引用显示文本。
export function formatRefNumber(numbering, num) {
  if (num == null || num === '') return num ?? '';
  switch (numbering) {
    case '(n)': return `(${num})`;
    case '[n]': return `[${num}]`;
    default: return String(num);
  }
}

export function typeDefOf(modelOrMeta, type) {
  const profile = modelOrMeta?.meta?.profileResolved || modelOrMeta?.profileResolved || modelOrMeta;
  return profile?.typeById?.[type] || null;
}

export function isLeafNode(modelOrMeta, node) {
  const def = typeDefOf(modelOrMeta, node?.type);
  return def ? !!def.leaf : node?.type === 'bib';
}

export function typeColor(modelOrMeta, type) {
  return typeDefOf(modelOrMeta, type)?.color || '#8a8a98';
}

export function nodeTag(modelOrMeta, node) {
  if (!node) return '';
  if (isLeafNode(modelOrMeta, node)) return `[${node.number ?? node.id}]`;
  return `${node.typeLabel || node.type || ''}${node.number ? ' ' + node.number : ''}`.trim() || node.id;
}
