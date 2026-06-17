// 用 buildModel 编译样例 JSON，报告结构指标（节点/边/环/未解析引用）
//   用法： npx vite-node scripts/check-sample.mjs samples/xxx.json
import { readFileSync } from 'node:fs';
import { buildModel } from '../src/model/graph.js';

const path = process.argv[2];
const data = JSON.parse(readFileSync(path, 'utf8'));
const m = buildModel(data);
const types = m.nodes.reduce((a, n) => { a[n.type] = (a[n.type] || 0) + 1; return a; }, {});
const unresolved = [];
for (const n of m.nodes) for (const r of (n.refs || [])) if (r.resolved === false) unresolved.push(`${n.id} -> ${r.target}`);
console.log(`${path}`);
console.log(`  nodes=${m.nodes.length} edges=${m.edges.length} hasCycle=${m.hasCycle} types=${JSON.stringify(types)}`);
console.log(`  unresolvedRefs=${unresolved.length}${unresolved.length ? ' :: ' + unresolved.slice(0, 8).join(', ') : ''}`);
console.log(`  title="${(data.meta && data.meta.title) || ''}"`);
