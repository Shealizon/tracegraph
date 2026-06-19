# LLM 案例测试（结构化普适性 + 提示词优化）

模型：`deepseek/deepseek-v4-pro`（opencode，官方 deepseek provider）。
提示词：`prompts/paper-graph-extract.md`（输出 `relation-graph@1` generic 格式，由 `adapter.compileGeneric` 自动推导边）。

## 调用管线（脚本化）

1. 源准备：tex/md 直接用；pdf 先 `pdftotext` 提取文本。源复制到 `.llmsrc/`（见下"坑1"）。
2. 生成：`opencode run --pure -m deepseek/deepseek-v4-pro -f prompts/paper-graph-extract.md -f <src> -- '<指令>' < /dev/null`（见"坑2"）。
3. 提取：`node scripts/extract-json.mjs <raw> samples/<name>.json`（去 ANSI/围栏，校验 JSON.parse）。
4. 校验：`npx vite-node scripts/check-sample.mjs samples/<name>.json`（buildModel 编译，报节点/边/环/未解析引用）。
5. 截图排查：`node scripts/import-shot.mjs samples/<name>.json <png> "<名>"`（动态 import store/adapter 注入项目并导航截图）。

### 关键坑（已解决）
- **坑1 · external_directory**：build agent 对 cwd 外的附件路径权限为 `ask`，非交互下挂起 → 把源复制进项目内 `.llmsrc/`（不入库）。
- **坑2 · stdin 必须 `< /dev/null`**：opencode 以 stdin 是否 TTY 判断交互模式；在 pty 下会进 TUI 把内容写控制终端、且 `> file` 重定向会挂起。`< /dev/null` 强制非交互、走 stdout。

## 结果（3 篇，覆盖 3 种格式 × 3 主题）

| 样例 | 源格式 | 主题 | 节点 | 边 | 未解析引用 | 视觉 |
|------|--------|------|------|----|-----------|------|
| uncertainty | md（讲义） | 不确定性原理(调和分析) | 11 | 7 | 0 | ✅ 类型色/编号/公式正常 |
| hardy | tex（100KB 论文） | Hardy 单边唯一延拓 | 24 | 53 | 0 | ✅ 与规则提取器节点数一致(24) |
| beurling | pdf→text | Beurling Fourier 唯一性 | 8 | 6 | 0 | ✅ PDF 退化文本被重建为正确 LaTeX |

- 三种格式均可生成**有效、可 `buildModel` 编译、引用 0 未解析**的图。
- **tex 最准**：hardy 24 节点与规则提取器 `paper-graph.json`(24) 完全一致，中心同为 THEOREM 22 "Audit"。
- **pdf 可用**：pdftotext 提取的数学常退化，但 deepseek 能把 statement 重建成规范 LaTeX（如 Beurling 的 `\iint|f||\hat f|e^{|xy|}`）。

## 提示词迭代（v1 → v2）

v1 截图排查发现两个问题，已在 v2 修复（规则 7、8）：
- **title 含 `$LaTeX$`**：节点标题不经公式渲染，会原样显示 `$L^2$...` → 规则 8：title 纯文本短名，数学只放 sections.body。
- **number 被填成定理名**：命名定理（Plancherel/Young）的名字被放进 number（大号位）→ 规则 7：number 只填显示编号，名字放 title。

v2 复测（hardy/beurling）：number 全为纯数字、title 纯文本，问题消除。

**v3（针对空卡片）**：讲义中"仅被引用、无陈述"的命名定理（Young/Plancherel）曾被建成空 `sections` 节点。加规则：① number 非空（无编号命名定理用其名）；② **禁止空 sections**（仅被引用的经典定理补一句标准陈述并标注，或不单独建节点）。重生成 uncertainty：thm:3.10 补足 statement，Young/Plancherel 归为外部引用，消除空卡片。

## 跨领域普适性 + 领域自适应类型

提示词升级为**按学科自定义节点类型**（不再固定数学的定理/命题/引理）。`types` 由 LLM 依领域定义并从统一调色板取色；渲染层颜色完全数据驱动。
> 修复了一个相关 bug：`compileProject` 跑过 `compileGeneric` 后输出未带 `types`，`buildModel` 二次 `compileGraph` 时因节点含 `sections` 被再判为 generic、却无 `types` 而退回默认 paper 配色 → 非数学类型全变灰。已让 `compileProject` 透传 `types`。

| 样例 | 领域 | 节点/边 | 领域类型（自适应） | 未解析 |
|------|------|---------|-------------------|-------|
| hardy | 数学 | 24/55 | 定理/命题/引理/文献 | 0 |
| bio | 行为·社科(q-bio) | 36/84 | 结论/假设/方法/概念/文献 | 0 |
| med | 医学影像(med-ph) | 27/30 | 方法/观察/实验/结论/文献 | 0 |
| cl | 语音·NLP(cs.CL) | 21/28 | 方法/结论/观察/文献 | 0 |

**结论**：同一提示词在数学/生物/医学/NLP 上都能给出**该学科自然的类型体系**与协调配色，均 0 未解析、0 公式错误、布局聚拢、视觉良好。（纯文学/人文论文 arxiv 稀缺，以 cs.CL 近似。）

## 对话记录留存（LLM 回归测试）
每次 LLM 提取的**原始输出**保存到 `samples/raw/<name>.raw.txt`；提示词版本由 git 追踪 `prompts/paper-graph-extract.md`。二者构成可复现的对话记录，便于回归与提示词迭代。校验用 `scripts/check-sample.mjs`（节点/边/未解析引用/空 sections）。

## 普适性结论与失败模式

- 引用解析规则（“target 必须指向存在 id”）有效：三篇均 0 未解析。
- 边召回：LLM 边数（hardy 53）少于规则提取（78），即 LLM 倾向只连主要依赖、漏次要 `\eqref` 等——**召回偏低但精度高**。
- 类型粒度：推论(Corollary)被并入 theorem（符合提示词），如需独立类型需扩 profile + 提示词。
- 规模/耗时：单篇约 1–4 分钟（随源大小）；100KB tex 约 4 分钟。

> 本轮做了 3 篇代表性样例（覆盖 md/tex/pdf 与不同主题）验证管线与提示词；管线已脚本化，可按需批量扩展到更多论文 / arxiv 在线检索的其它领域。
