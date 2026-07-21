// =============================================================================
// model/graph.js  —  Phase 2 模型层
//
// 载入 tracegraph.json，建立索引、标签锚点角度、依赖关系，并计算重要度评分：
//
//   I(n) = deg_out(n) + Σ_{m -> n} I(m)        （无环时，沿凝聚 DAG 递归）
//   若 n 处于真正的环（SCC 大小 > 1）则退化为  I(n) = deg(n)（总度数）
//
//   边方向约定： A.label --> B.refs  表示 “A 被 B 使用”（A 是 B 的依赖）。
//   - deg_out(n) = 以 n 的某 label 为起点的边数 = n 被引用次数
//   - “指向 n 的节点集” = {A : 存在边 A->n} = n 的依赖集
// =============================================================================

import rawInput from '../data/tracegraph.json';
import { compileGraph } from '../data/adapter.js';

export const KIND_ORDER = { theorem: 0, proposition: 1, lemma: 2, bib: 3 };

export function buildModel(input = rawInput) {
  // 通过适配器统一规整：既支持论文 tracegraph.json（已编译格式），也支持通用
  // relation-graph schema（见 data/schema.js 与 docs/DATA-SCHEMA.md）。
  const raw = compileGraph(input);
  const nodes = raw.nodes.map((n) => ({ ...n }));
  const edges = raw.edges.map((e) => ({ ...e }));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // label -> {node, label}
  const labelIndex = new Map();
  for (const n of nodes) {
    for (const l of n.labels) labelIndex.set(l.id, { node: n, label: l });
  }

  // 邻接（节点级，去重）
  const outAdj = new Map(nodes.map((n) => [n.id, new Set()])); // n 被谁用： n -> 使用者集合
  const inAdj = new Map(nodes.map((n) => [n.id, new Set()])); // n 用了谁： n -> 依赖集合
  for (const e of edges) {
    if (!nodeById.has(e.from) || !nodeById.has(e.to)) continue;
    outAdj.get(e.from).add(e.to); // from 被 to 使用
    inAdj.get(e.to).add(e.from); // to 依赖 from
  }

  // 节点级依赖图（dep: 使用者 -> 依赖集），用于评分递归
  const deps = inAdj; // n -> n 的依赖集合（指向 n 的节点）
  const usedBy = outAdj; // n -> 使用 n 的节点集合

  // --- Tarjan SCC ---
  const sccId = tarjanSCC(nodes, (id) => usedBy.get(id)); // 在 “A->B(被使用)” 有向图上求 SCC
  const sccSize = new Map();
  for (const id of sccId.values()) sccSize.set(id, (sccSize.get(id) || 0) + 1);

  // --- 度数 ---
  const degOut = (id) => usedBy.get(id).size; // 被使用次数
  const degIn = (id) => deps.get(id).size; // 依赖个数
  const degTotal = (id) => degOut(id) + degIn(id);

  // --- 重要度：在凝聚 DAG 上做 memo 递归 ---
  // I(n) = degOut(n) + Σ_{m ∈ deps(n)} I(m)，但若 n 在环里则 I(n)=degTotal(n)
  const inCycle = (id) => (sccSize.get(sccId.get(id)) || 1) > 1;
  const memo = new Map();
  const computeI = (id, stack) => {
    if (memo.has(id)) return memo.get(id);
    if (inCycle(id)) {
      const v = Math.max(1, degTotal(id));
      memo.set(id, v);
      return v;
    }
    // 防御：万一仍有跨 SCC 的回边导致递归环（理论上凝聚后不会），用 stack 兜底
    if (stack.has(id)) return Math.max(1, degTotal(id));
    stack.add(id);
    let acc = degOut(id);
    for (const m of deps.get(id)) {
      // 同一 SCC 内的依赖不计入递归（避免环内自加），跨 SCC 才递归
      if (sccId.get(m) === sccId.get(id)) continue;
      acc += computeI(m, stack);
    }
    stack.delete(id);
    const v = Math.max(1, acc);
    memo.set(id, v);
    return v;
  };

  let maxI = 1;
  for (const n of nodes) {
    n.degOut = degOut(n.id);
    n.degIn = degIn(n.id);
    n.degTotal = degTotal(n.id);
    n.inCycle = inCycle(n.id);
    n.importance = computeI(n.id, new Set());
    if (n.importance > maxI) maxI = n.importance;
  }

  // 半径映射：面积 ∝ importance（sqrt），温和差异，夹到 [RMIN, RMAX]
  const RMIN = 30;
  const RMAX = 72;
  const profile = raw.meta?.profileResolved;
  const isLeaf = (n) => (profile ? !!profile.typeById?.[n.type]?.leaf : n.type === 'bib');
  for (const n of nodes) {
    if (isLeaf(n)) {
      n.radius = 24;
      continue;
    }
    const t = Math.sqrt(n.importance) / Math.sqrt(maxI);
    n.radius = RMIN + (RMAX - RMIN) * t;
  }

  // 为每个节点的 labels 计算静态展开角度（运行时会按邻居方向再微调）
  for (const n of nodes) {
    const count = n.labels.length;
    n.labels.forEach((l, i) => {
      l.baseAngle = (i / Math.max(1, count)) * Math.PI * 2 - Math.PI / 2;
    });
  }

  const hasCycle = [...sccSize.values()].some((s) => s > 1);

  return {
    meta: raw.meta,
    nodes,
    edges,
    tags: raw.tags || raw.meta?.tags || [],
    nodeById,
    labelIndex,
    deps, // n -> 依赖集合
    usedBy, // n -> 使用者集合
    sccId,
    hasCycle,
    maxImportance: maxI,
  };
}

// 标准 Tarjan，successors(id) 返回邻接 id 的可迭代
function tarjanSCC(nodes, successors) {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const comp = new Map();
  let compCounter = 0;

  const ids = nodes.map((n) => n.id);

  function strongconnect(v) {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of successors(v)) {
      if (!idx.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), idx.get(w)));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const cid = compCounter++;
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.set(w, cid);
      } while (w !== v);
    }
  }

  for (const v of ids) if (!idx.has(v)) strongconnect(v);
  return comp;
}

// 计算某节点的上游依赖锥（递归所有依赖）
export function dependencyCone(model, startId) {
  const cone = new Set();
  const stack = [startId];
  while (stack.length) {
    const id = stack.pop();
    for (const dep of model.deps.get(id) || []) {
      if (!cone.has(dep)) {
        cone.add(dep);
        stack.push(dep);
      }
    }
  }
  return cone;
}
