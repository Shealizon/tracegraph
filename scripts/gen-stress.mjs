// =============================================================================
// gen-stress.mjs  —  压力测试数据生成 + buildModel 基准
//   用法： npx vite-node scripts/gen-stress.mjs   （vite-node 支持 json import）
// =============================================================================
import { writeFileSync } from 'node:fs';
import { buildModel } from '../src/model/graph.js';

const TYPES = ['theorem', 'proposition', 'lemma'];

export function genGraph(n, shape = 'dag', density = 3) {
  const nodes = [];
  const edges = [];
  for (let i = 0; i < n; i += 1) {
    nodes.push({
      id: `n${i}`, type: TYPES[i % 3], number: String(i + 1), title: `Node ${i}`,
      statementBody: `Statement ${i} \\ref{n${Math.max(0, i - 1)}}`, proofBody: '',
      labels: [{ id: `n${i}`, kind: 'theorem', number: String(i + 1) }], refs: [],
    });
  }
  const add = (a, b) => edges.push({ from: `n${a}`, fromLabel: `n${a}`, to: `n${b}` });
  if (shape === 'chain') {
    for (let i = 1; i < n; i += 1) add(i - 1, i);
  } else if (shape === 'star') {
    for (let i = 1; i < n; i += 1) add(0, i);
  } else if (shape === 'cycle') {
    for (let i = 0; i < n; i += 1) add(i, (i + 1) % n); // 单个大 SCC
  } else { // dag：每个节点依赖若干更早的节点（随机前向）
    for (let i = 1; i < n; i += 1) {
      const k = Math.min(i, 1 + Math.floor(Math.random() * density));
      const seen = new Set();
      for (let t = 0; t < k; t += 1) {
        const j = Math.floor(Math.random() * i);
        if (seen.has(j)) continue;
        seen.add(j);
        add(j, i);
      }
    }
  }
  return { meta: { title: `stress-${shape}-${n}` }, nodes, edges };
}

function bench() {
  const shapes = ['dag', 'chain', 'star', 'cycle'];
  const sizes = [200, 500, 1000, 2000];
  const RUNS = 3;
  console.log('shape\tN\tedges\tbuildModel_ms\thasCycle\tmaxI');
  for (const shape of shapes) {
    for (const N of sizes) {
      const g = genGraph(N, shape);
      buildModel(g); // warmup
      const t = performance.now();
      let m;
      for (let r = 0; r < RUNS; r += 1) m = buildModel(g);
      const ms = (performance.now() - t) / RUNS;
      console.log(`${shape}\t${N}\t${g.edges.length}\t${ms.toFixed(2)}\t${m.hasCycle}\t${m.maxImportance}`);
    }
  }
}

bench();

// 导出一个大样例供浏览器侧 CDP 压测
const big = genGraph(800, 'dag', 4);
writeFileSync('C:/temp/stress-graph.json', JSON.stringify(big));
console.log(`\nwrote C:/temp/stress-graph.json nodes=${big.nodes.length} edges=${big.edges.length}`);
