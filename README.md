# Hardy 唯一延拓性 · 论证依赖图查看器

交互式可视化 `one-sided-hardy-unique-continuation-verified.tex` 中定理/引理/命题之间的
引用依赖关系。类 Obsidian 关系图谱，支持点击展开 modal、引用 hover 预览、并排对照、
全屏详情页等。

## 快速开始

```bash
npm install
npm run extract     # 从 ../*.tex (+ .aux) 生成 src/data/paper-graph.json
npm run dev         # 本地开发服务器（自动打开浏览器）
npm run build       # 构建到 dist/（base 为相对路径，可直接打开 dist/index.html）
npm run preview     # 预览 dist/
```

## 数据流水线

```
one-sided-hardy-...-verified.tex  ─┐
one-sided-hardy-...-verified.aux  ─┴► scripts/extract.mjs ► src/data/paper-graph.json ► 前端
```

- **编号**优先取自 `.aux`，与 PDF 完全一致（定理共享计数器、129 个公式）。
- 重新编辑论文后重跑 `npm run extract` 即可刷新。

## 对象化格式（node -- label 模型）

```jsonc
node  = { id, type, number, title, statementBody, proofBody, labels[], refs[] }
label = { id, kind: "theorem"|"equation", number }
ref   = { cmd, target, targetNode, kind, where, internal }
edge  = { from, fromLabel, to }   // A.label --> B.refs   表示 “A 被 B 使用”
```

## 交互

- **点击节点** → 展开为 modal（A4 比例，超长滚动）。modal 有物理质量，会推开其它节点。
- **顶部按钮**：切回节点 ○ / 打开所有“被引用者” ↗ / 打开所有“依赖” ↙ / 全屏详情 ⤢。
- **底部**：折叠/展开证明。
- **引用块**（彩色）：hover 弹出浮动预览（可递归层叠）；点击并排展开目标 modal + 关系箭头。
- **侧栏**：搜索跳转 / 视图模式（正常 · 仅显示 Modals · 关闭所有）/ 重置·reheat / 类型过滤 / 图例。
- **重要度评分**：`I(n)=deg_out(n)+Σ_{m→n} I(m)`，环内退化为度数（Tarjan SCC）。圆越大越重要。
- **Deep-link**：URL hash `#open=thm:conditional,lem:gauge&mode=show-modals-only` 可恢复视图。

## 开发/回归工具（scripts/）

- `smoke-render.mjs` — 用 KaTeX 对论文全部数学段做渲染冒烟测试（应 0 error）。
- `cdp-verify.mjs <url> <out.png> <scenario>` — 用 Chrome DevTools Protocol 做交互验证与截图，
  scenario ∈ `errors|click-ref|hover-ref|details|modals-only`。需先 `npm run preview` 并以
  `--remote-debugging-port=9222` 启动 Chrome。

## 目录

```
scripts/extract.mjs      tex+aux -> JSON
src/model/graph.js       索引 / SCC 环检测 / 重要度评分 / 依赖锥
src/render/tex.js        LaTeX 片段 -> HTML（KaTeX + 编号 + 交互引用）
src/view/forceGraph.js   d3 力导向图 + modal 矩形碰撞物理 + pan/zoom
src/view/modal.js        节点 <-> modal 形变与按钮
src/view/refLayer.js     hover 预览栈 / click 并排 / 关系箭头
src/view/detailsPage.js  全屏详情页
src/ui/sidebar.js        侧栏
```
