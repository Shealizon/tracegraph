import { performance } from 'node:perf_hooks';
import { buildModel } from '../src/model/graph.js';

const TYPES = ['theorem', 'proposition', 'lemma'];

function makeRng(seed = 42) {
  let x = seed >>> 0;
  return () => {
    x = (1664525 * x + 1013904223) >>> 0;
    return x / 0x100000000;
  };
}

function genGraph(n, shape = 'dag', density = 4) {
  const rng = makeRng(n * 17 + shape.length);
  const nodes = Array.from({ length: n }, (_, i) => ({
    id: `n${i}`,
    type: TYPES[i % TYPES.length],
    number: String(i + 1),
    title: `Node ${i}`,
    statementBody: `Statement ${i}`,
    proofBody: '',
    labels: [{ id: `n${i}`, kind: 'theorem', number: String(i + 1) }],
    refs: [],
  }));
  const edges = [];
  const add = (from, to) => edges.push({ from: `n${from}`, fromLabel: `n${from}`, to: `n${to}` });

  if (shape === 'chain') {
    for (let i = 1; i < n; i += 1) add(i - 1, i);
  } else if (shape === 'star') {
    for (let i = 1; i < n; i += 1) add(0, i);
  } else if (shape === 'cycle') {
    for (let i = 0; i < n; i += 1) add(i, (i + 1) % n);
  } else {
    for (let i = 1; i < n; i += 1) {
      const k = Math.min(i, 1 + Math.floor(rng() * density));
      const seen = new Set();
      for (let t = 0; t < k; t += 1) {
        const j = Math.floor(rng() * i);
        if (!seen.has(j)) {
          seen.add(j);
          add(j, i);
        }
      }
    }
  }

  return { meta: { title: `perf-${shape}-${n}` }, nodes, edges };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function measure(graph, runs = 7) {
  buildModel(graph);
  const samples = [];
  let model;
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    model = buildModel(graph);
    samples.push(performance.now() - t0);
  }
  return { model, ms: median(samples) };
}

const cases = [
  { shape: 'dag', n: 1000, budgetMs: 40 },
  { shape: 'dag', n: 4000, budgetMs: 220 },
  { shape: 'chain', n: 4000, budgetMs: 120 },
  { shape: 'star', n: 4000, budgetMs: 120 },
  { shape: 'cycle', n: 4000, budgetMs: 120 },
];

const rows = [];
let failed = false;

for (const item of cases) {
  const graph = genGraph(item.n, item.shape);
  const { model, ms } = measure(graph);
  const ok = ms <= item.budgetMs;
  if (!ok) failed = true;
  rows.push({
    shape: item.shape,
    nodes: item.n,
    edges: graph.edges.length,
    medianMs: Number(ms.toFixed(2)),
    budgetMs: item.budgetMs,
    hasCycle: model.hasCycle,
    maxImportance: model.maxImportance,
    ok,
  });
}

console.table(rows);

if (failed) {
  console.error('graph performance budget exceeded');
  process.exitCode = 1;
}
