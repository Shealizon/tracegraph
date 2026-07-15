# Entail · 关系依赖图查看器

交互式可视化任意「带交叉引用的关系结构」中实体之间的依赖关系——类 Obsidian 关系图谱。
源于可视化数学论文的定理/引理/公式引用链，现已通用化：论文、讲义、笔记、需求条目、
知识卡片……凡是「实体之间存在引用/依赖」的结构都能导入并复用整套交互（力导向图、
点击展开 modal、引用 hover 预览、并排对照、全屏详情、主线/章节标签等）。

## 快速开始

```bash
npm install
npm run dev:server  # 终端 1：账号、同步、云端任务 API
npm run dev         # 终端 2：Vite 客户端（自动打开浏览器）
npm run build       # 构建到 dist/（base 为相对路径，可直接打开 dist/index.html）
npm start           # 生产模式：API + dist，默认 http://localhost:8787
npm test            # Vitest（监视模式）；npm run test:run 跑一次
```

首次打开进入**引导页**（leading），内置一个 Hardy 唯一延拓性样例项目。无需任何
构建步骤即可创建项目、导入文件、配置后进入关系图。

## 路由与界面

URL 以查询参数区分两个界面：

- `?screen=leading`（默认）— **引导页**：项目卡片墙。新建/打开/配置/导出/删除项目，
  拖文件到页面即可新建项目并导入。
- `?screen=main&project=<id>` — **关系图主界面**。视图状态（展开的卡片、缩放、
  力参数、主题、标签等）编码在 URL `#hash` 里，可分享/恢复（deep-link）。

## 项目与存储

应用是**离线优先的多项目服务**：未登录时全部功能继续使用浏览器 IndexedDB；登录后项目会
保留本地副本并同步到按用户隔离、密码加密保护的服务端工作区。冲突按 `updatedAt` 的最新修改
合并，退出登录不会清除本地项目。部署、安全和 AI 云端任务说明见
[`docs/SERVER.md`](docs/SERVER.md)。

- **项目** = 一组**文档** + 配置（启用哪些文档、禁用哪些节点/关系、标签、视图状态）。
- 一个项目可包含多篇文档；跨文档引用按 id/文档名/slug 自动解析并连边，冲突 id 自动唯一化。
- **导入**（引导页或主界面侧栏「导入文件」/项目配置弹窗，支持拖拽、多选）：
  - `.json` — 结构化关系图（`relation-graph@1`）或导出的项目文件。
  - `.tex` / `.txt` — 通用 TeX 自动识别：本地发现定理类环境并自动编号，无需固定格式。
- **导出** — 下载 `*.paper-graph-project.json`，可再导入到任意设备。

## 数据格式（relation-graph@1）

通用数据 schema 与领域解耦，运行时由 `data/adapter.js` 编译为内部格式。完整说明见
[`docs/DATA-SCHEMA.md`](docs/DATA-SCHEMA.md)。核心结构：

```jsonc
{
  "format": "relation-graph@1",
  "meta":  { "title", "profile": "paper"|"generic", "bodyFormat": "latex"|"markdown"|"text", "macros": {} },
  "types": [ { "id", "label", "color", "leaf"?, "order"? } ],   // 节点类型（皮肤）
  "nodes": [ {
    "id", "type", "number", "title",
    "sections": [ { "kind": "statement"|"proof"|…, "body" } ],
    "anchors":  [ { "id", "kind"?, "number"? } ],               // 可被引用的锚点
    "refs":     [ { "target", "relation": "ref"|"cite", "where"? } ]
  } ],
  "tags": [ { "id", "kind": "ordered"|"unordered", "members": [nodeId…] } ]  // 可选
}
```

- **profile（皮肤）**决定有哪些节点类型、配色、是否为叶子、引用编号格式。内置 `paper`
  （定理/命题/引理/文献）与 `generic`（主节点/节点/支撑/来源），也可在数据里自定义 `types`。
- 依赖关系**只写 `refs`**（A 的正文引用 B），系统据此自动派生边，无需手写 `edges`。
- 兼容老的论文运行时格式（`statementBody`/`proofBody`/`labels`/`refs.cmd`），直接透传。

### 用 LLM 把论文转成 JSON

`prompts/paper-graph-extract.md` 是一份现成提示词：把任意学科的论文/讲义喂给 LLM，
产出严格的 `relation-graph@1` JSON，存盘后直接导入即可。

## 交互

- **点击节点** → 展开为 modal（A4 比例，超长滚动）。modal 有物理质量，会推开其它节点。
- **顶部按钮**：切回节点 / 打开所有「被引用者」/ 打开所有「依赖」/ 全屏详情 / pin 锁定。
- **底部**：折叠/展开证明。
- **引用块**（彩色）：hover 弹出浮动预览（可递归层叠）；点击并排展开目标 modal + 关系箭头。
- **节点 hover**：邻居高亮 + 完整信息预览浮窗。
- **侧栏**：搜索跳转 / 视图模式（正常 · 仅显示 Modals · 关闭所有）/ 重置·reheat /
  力参数 / 类型过滤 / 标签管理 / 主题（暗·跟随系统·亮）/ 导入·导出·项目配置 / 图例。
- **标签**：有序（主线/章节/步骤，带序号贴片）与无序（喜爱/已看过…）两类，打标模式下点节点
  增删成员，可「仅看此标签」过滤。详见 `docs/`。
- **重要度评分**：`I(n)=deg_out(n)+Σ_{m→n} I(m)`，环内退化为度数（Tarjan SCC）。圆越大越重要。
- **撤销**：展开/折叠/隐藏/pin/重新布局等结构操作可 `Ctrl/Cmd+Z` 撤销。
- **Deep-link**：URL hash 编码展开卡片、模式、缩放、力参数、隐藏、pin、主题等，可恢复整个视图。

## 目录

```
index.html               #app: sidebar + stage（edges/nodes/overlay/tag 四层）
src/main.js               入口；leading/main 路由与关系图状态机（ctx）
src/data/schema.js        profile（皮肤）定义 / 标签规整 / 类型与编号辅助
src/data/adapter.js       relation-graph@1 通用 schema -> 运行时格式
src/data/paper-graph.json 内置 Hardy 样例数据
src/project/store.js      IndexedDB 多项目存储
src/project/projectAdapter.js  项目规整 / 多文档编译（跨文档引用解析、id 唯一化）
src/project/projectConfig.js   项目配置弹窗 / 导入导出 / 创建项目
src/import/texExtract.js  固定格式 TeX(+aux) 抽取
src/import/texGeneric.js  通用 TeX 自动识别抽取
src/model/graph.js        索引 / SCC 环检测 / 重要度评分 / 依赖锥
src/render/tex.js         正文片段 -> HTML（KaTeX + 编号 + 交互引用）
src/view/leadingPage.js   引导页（项目卡片墙）
src/view/forceGraph.js    d3 力导向图 + modal 矩形碰撞物理 + pan/zoom
src/view/modal.js         节点 <-> modal 形变与按钮
src/view/refLayer.js      hover 预览栈 / click 并排 / 关系箭头
src/view/detailsPage.js   全屏详情页
src/ui/sidebar.js         侧栏；ui/icons.js 图标；ui/feedback.js toast/confirm
```

## 开发/回归工具（scripts/）

一组用 Chrome DevTools Protocol 做交互验证与截图的脚本（多数需先 `npm run preview`，
并以 `--remote-debugging-port=9222` 启动 Chrome）：

- `smoke-render.mjs` — 用 KaTeX 对全部数学段做渲染冒烟测试（应 0 error）。
- `cdp-verify.mjs <url> <out.png> <scenario>` — 交互验证与截图，
  scenario ∈ `errors|click-ref|hover-ref|details|modals-only`。
- `extract.mjs` / `extract-json.mjs` — 从 `.tex(+.aux)` 离线生成关系图 JSON。
- `gen-stress.mjs` — 生成压力测试数据（见 `docs/STRESS.md`）；其余 `verify-*.mjs`/`*-shot.mjs`
  为各专项回归（配色、去重 id、对话框、过滤、性能 tick 等）。
