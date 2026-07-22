# Tracegraph · 关系知识图谱工作台

Tracegraph 用交互式关系图组织带引用、依赖和论证链的结构化知识。项目最初于
2026-06-17 从数学论文关系图工具独立出来，现已发展为覆盖图谱浏览、沉浸阅读、标注笔记、
AI 协作、文件工作区和加密云同步的完整工作台。

线上访问地址：[https://graph.akusm.com](https://graph.akusm.com)

它适用于论文、讲义、研究笔记、需求条目、知识卡片等场景：只要实体之间存在引用或依赖，
就能导入同一套图模型，并使用力导向布局、递归预览、阅读链、标签、全文注释和 AI 工具进行探索。

## 当前能力

- **关系图谱**：D3 力导向布局、节点与卡片形变、依赖方向、递归引用预览、邻居高亮、
  SCC 环检测和重要度评分。
- **多项目、多文档**：项目级配置、跨文档引用解析、重复 ID 唯一化、文档与类型筛选、
  IndexedDB 离线存储和完整数据导入导出。
- **阅读与知识整理**：桌面和移动阅读器、多标签阅读链、Markdown/LaTeX 渲染、文本与位置标注、
  有序/无序标签、独立或附着笔记、图谱/文件/片段引用。
- **内容编辑**：受保护的节点新增、编辑与删除，以及项目配置、文档启停和关系重编译。
- **AI 工作台**：流式对话、reasoning 与工具过程、上下文预算和压缩、附件、会话恢复与导出；
  AI 可搜索图谱、批量读取节点和邻居、读取笔记与工作区文件、解析 PDF，并把生成文件写回工作区。
- **多种模型运行方式**：浏览器本地模型、服务端持久云任务，以及带串行队列和隔离临时工作区的
  Codex Cloud。
- **云端账号与同步**：离线优先；登录后将项目、AI 状态和工作区同步到按用户隔离的
  AES-256-GCM 加密存储。支持管理员托管账号、修改密码和封闭注册。
- **Skills 与工具扩展**：管理员可导入 `tracegraph-extension@1`；Python 工具使用独立虚拟环境。
  内置 PDF 工作台和 PaddleOCR 扩展。
- **诊断与回归**：Vitest、覆盖率、稳定图算法性能门禁、KaTeX 冒烟测试、CDP 交互截图脚本，
  以及会自动脱敏的运行时诊断导出。

## 演进概览

README 首次创建于 2026-06-17。根据该提交到当前 `HEAD` 的 Git 差异，项目主要经历了：

| 时间 | 主要变化 |
| --- | --- |
| 2026-06-17—06-21 | 从单篇论文图扩展为多项目、多文档通用关系图；完善 deep-link、撤销、pin、LOD、跨文档引用和渲染性能。 |
| 2026-06-22—06-25 | 建立统一标签与片段标注系统，加入移动端侧栏、多标签阅读器、选择复制和阅读链恢复。 |
| 2026-07-14—07-15 | 新增 AI 面板、图谱工具调用、注释与独立笔记、上下文预算/压缩和移动端交互。 |
| 2026-07-16 | 服务端化：账号、加密工作区、离线同步、持久 AI/Codex 任务、管理员扩展、PDF/OCR 与文件预览。 |
| 2026-07-17 | 连续 PDF 阅读、统一片段引用、预览附件、托管账号与密码修改、受保护的节点 CRUD。 |
| 2026-07-21 | 项目、协议、存储键与部署设施统一为 Tracegraph；补充品牌资源、加载进度和 Linux 部署换行约束。 |

完整提交记录可通过 `git log --date=short --oneline` 查看。

## 快速开始

### 环境要求

- Node.js 22（生产镜像使用 Node 22）
- npm
- Python 3.9+、`pip` 和 `venv`（仅在运行 Python 扩展时需要）

### 本地开发

```bash
npm ci
npm run dev:server  # 终端 1：API、账号、同步和云端任务，默认 :8787
npm run dev         # 终端 2：Vite 客户端，默认 :5183 并代理 /api
```

Vite 会自动打开浏览器。首次进入引导页时会创建一个内置 Hardy 唯一延拓性样例项目。
未登录也可以使用本地图谱、阅读、标注和浏览器侧 AI 能力。

服务端配置项见 [`.env.example`](.env.example)。默认数据目录是 `server-data/`；生产环境应设置
`TRACEGRAPH_DATA`，并妥善配置管理员账号、注册策略、Codex 和 OCR 相关变量。

### 构建与生产运行

```bash
npm run build
npm start            # 同一 Node 进程提供 dist/ 与 /api，默认 http://localhost:8787
```

也可使用容器：

```bash
docker compose up --build
```

详细安全模型、环境变量和生产部署说明见 [`docs/SERVER.md`](docs/SERVER.md)。

## 路由与界面

- `?screen=leading`（默认）：项目卡片墙，可新建、打开、配置、导入、导出和删除项目。
- `?screen=main&project=<id>`：关系图主界面。
- `?screen=reader&project=<id>`：沉浸阅读界面；阅读页与导航链会写入 URL。
- 图谱视角、展开卡片、模式、力参数、隐藏项、pin、主题和阅读状态会编码到 URL hash，
  可分享并恢复 deep-link。

## 项目、同步与导入导出

Tracegraph 是离线优先的多项目应用。浏览器 IndexedDB 始终保留本地副本；登录后，项目和删除墓碑
会与用户的加密服务端工作区同步，冲突按 `updatedAt` 合并，退出登录不会清除本地数据。

- **项目**：文档集合 + 启用状态 + 禁用节点/关系 + 标签和笔记 + 视图配置。
- **导入格式**：
  - `.json`：`relation-graph@1` 结构化图或 Tracegraph 项目文件。
  - `.tex` / `.txt`：通用 TeX 自动识别；本地发现定理类环境并自动编号。
- **项目结构导出**：`*.tracegraph-project.json`。
- **项目完整导出**：`*.tracegraph-project-data.json`，包含项目、AI 对话、浏览器状态和项目工作区文件。
- **全局完整导出**：`tracegraph-all-data-*.json`，包含全部项目、对话和工作区。
- **AI 单会话导出**：包含完整轮次、reasoning、工具参数与结果、来源和附件元数据。

## 数据格式：`relation-graph@1`

输入 schema 与具体领域解耦，由 [`src/data/adapter.js`](src/data/adapter.js) 编译为运行时图模型。
完整字段说明见 [`docs/DATA-SCHEMA.md`](docs/DATA-SCHEMA.md)。核心结构如下：

```jsonc
{
  "format": "relation-graph@1",
  "meta": {
    "title": "Example",
    "profile": "paper",
    "bodyFormat": "markdown",
    "macros": {}
  },
  "types": [
    { "id": "result", "label": "Result", "color": "#64748b", "leaf": false, "order": 1 }
  ],
  "nodes": [{
    "id": "node-1",
    "type": "result",
    "number": "1",
    "title": "Example node",
    "sections": [{ "kind": "statement", "body": "..." }],
    "anchors": [{ "id": "node-1", "kind": "statement" }],
    "refs": [{ "target": "node-0", "relation": "ref", "where": "statement" }]
  }],
  "tags": [{ "id": "main", "kind": "ordered", "members": ["node-1"] }]
}
```

- `profile` 决定节点类型、配色、叶节点和引用编号格式；内置 `paper` 与 `generic`，也可自定义 `types`。
- 依赖关系只需写在节点的 `refs` 中，系统会自动派生边。
- `anchors` 为公式、段落等可引用位置提供稳定目标。
- [`prompts/tracegraph-extract.md`](prompts/tracegraph-extract.md) 可用于让 LLM 从论文或讲义生成
  `relation-graph@1` JSON。

## 图谱、阅读与笔记交互

- 点击节点可展开为带物理质量的卡片；可继续展开被引用者或依赖项、锁定位置、进入详情阅读器。
- 引用块 hover 会显示可递归层叠的预览；点击后并排打开目标并绘制关系箭头。
- 阅读器支持多标签页、前后阅读链、滚动时自动收起工具栏、移动端选择复制和引用预览。
- 标签可表示主线、章节、步骤、喜爱或阅读状态；成员可以是节点、文本片段或空间位置。
- 笔记支持 Markdown、公式、图谱引用，可附着到标签成员，也可作为独立笔记存在并加入 AI 上下文。
- 结构操作支持 `Ctrl/Cmd+Z` 撤销；`Ctrl+F10` 导出脱敏诊断日志。

## AI、工作区与扩展

AI 会话可选择浏览器本地、云端或 Codex Cloud 运行。登录状态下，云端任务会在网页关闭后继续；
会话附件和生成文件存放在用户的加密工作区中，可直接预览文本、图片和 PDF。

管理员可以导入 `tracegraph-extension@1` 扩展包：

```bash
npm run pack:extension -- ./my-extension ./my-extension.extension.json
npm run verify:extensions
```

扩展协议、权限、Python 隔离和产物写回规则见 [`docs/EXTENSIONS.md`](docs/EXTENSIONS.md)。

## 测试与回归

```bash
npm run test:run          # 单次运行全部 Vitest 测试
npm run test              # 监视模式
npm run coverage          # 纯逻辑层覆盖率
npm run test:perf         # DAG、chain、star、cycle 的稳定图算法性能门禁
npm run build             # 生产构建验证
node scripts/smoke-render.mjs
```

`scripts/` 还包含基于 Chrome DevTools Protocol 的交互验证、截图、导入、配色、去重 ID、筛选和
渲染性能脚本。测试基线、已知缺口和后续建议见 [`docs/TESTING-REPORT.md`](docs/TESTING-REPORT.md)。

## 目录结构

```text
index.html                    应用 HTML 与品牌/加载入口
src/main.js                   leading/main/reader 路由与应用状态机
src/data/                     schema、图谱/文件引用、笔记和内置样例
src/project/                  IndexedDB、项目编译、配置和节点操作
src/model/graph.js            索引、SCC 环检测、重要度与依赖锥
src/render/                   Markdown、KaTeX 和交互引用渲染
src/view/                     力导向图、卡片、阅读器、引用层和标注
src/ui/                       侧栏、AI、节点编辑、笔记和工作区预览
src/ai/                       模型客户端、上下文、工具、附件和工作区
src/cloud/                    账号、会话、同步、管理员和云端状态
server/                       API、加密用户仓、任务队列、Codex 与扩展注册
extensions/builtin/           PDF 工作台和 PaddleOCR
deploy/                       systemd、Nginx 与 Git post-receive 部署配置
scripts/                      抽取、打包、验证、截图和性能工具
tests/                        单元、集成和回归测试
docs/                         schema、服务端、扩展、压力测试和设计文档
```

## 部署

仓库提供 Docker Compose，以及 `graph.akusm.com` 当前使用的 systemd、Nginx 和
Git `post-receive` 配置。推送服务器远端的 `main` 后会自动执行依赖安装、审计、测试和构建，
再更新 `/opt/tracegraph`、重启 `tracegraph.service` 并重载 Nginx。
