// 从 opencode run 原始输出中提取 JSON 并校验，写入 samples/
//   用法： node scripts/extract-json.mjs <raw.txt> <out.json>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [rawPath, outPath] = process.argv.slice(2);
let s = readFileSync(rawPath, 'utf8');
// 去 ANSI、去可能的代码围栏
s = s.replace(/\x1b\[[0-9;]*m/g, '');
const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
if (fence) s = fence[1];
const a = s.indexOf('{');
const b = s.lastIndexOf('}');
if (a < 0 || b < 0) { console.error('no JSON braces found'); process.exit(1); }
const obj = JSON.parse(s.slice(a, b + 1)); // 抛错即视为失败
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(obj, null, 2));
const nodes = obj.nodes || [];
const types = {};
for (const n of nodes) types[n.type] = (types[n.type] || 0) + 1;
const refs = nodes.reduce((s2, n) => s2 + (n.refs ? n.refs.length : 0), 0);
console.log(`ok: ${nodes.length} nodes (${JSON.stringify(types)}), ${refs} refs -> ${outPath}`);
