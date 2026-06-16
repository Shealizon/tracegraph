# 通用关系结构 Schema 说明（relation-graph@1）

本查看器最初用于可视化数学论文的“定理 / 引理 / 公式 / 引用”依赖关系，但其内核只是一个
**带交叉引用的有向关系图**。本文件定义一份与领域无关的通用数据格式，任何“实体之间存在
引用 / 依赖关系”的结构（论文、笔记、需求条目、法条、代码模块、知识卡片……）都可以转换成它
并直接复用整套交互（力导向图、modal 展开、引用 hover 预览、关系箭头、详情页）。

> 你（或 LLM）只需产出符合本格式的 JSON，把它保存为
> `src/data/paper-graph.json`（沿用旧文件名即可），重新 `npm run build` / `npm run dev`
> 即可看到效果。运行时会自动识别并编译通用格式。

---

## 1. 顶层结构

```jsonc
{
  "format": "relation-graph@1",      // 必填：标识为通用格式，触发自动编译
  "meta": {
    "title": "图标题",
    "profile": "generic",            // 可选：内置皮肤 "paper" | "generic"
    "bodyFormat": "markdown",        // 可选：正文渲染方式 "latex" | "markdown" | "text"
    "macros": {}                     // 可选：仅 latex 时的 KaTeX 宏
  },
  "types":     [ TypeDef, ... ],     // 可选：自定义节点类型（覆盖 profile 默认）
  "relations": [ RelationDef, ... ], // 可选：自定义引用关系
  "nodes":     [ Node, ... ]         // 必填：实体列表
}
```

### TypeDef —— 节点类型（决定颜色 / 标签 / 是否为叶子）

```jsonc
{
  "id":    "primary",     // 类型标识，节点 node.type 引用它
  "label": "结论",         // 显示名（节点圆、详情页标题用）
  "color": "#7c9cff",     // 该类型主题色
  "leaf":  false,         // 可选：true 表示“来源/引用条目”，圆更小、点击进详情而非 modal
  "order": 0              // 可选：排序权重
}
```

### RelationDef —— 引用关系（决定编号显示格式）

```jsonc
{
  "id":        "cite",    // 关系标识，node.refs[].relation 引用它
  "label":     "出处",
  "numbering": "[n]"      // 引用显示模板： "n" | "(n)" | "[n]"
}
```

---

## 2. Node —— 实体

```jsonc
{
  "id":     "C1",            // 必填：全局唯一标识
  "type":   "primary",       // 必填：types[].id 之一
  "number": "1",             // 可选：显示序号（字符串）
  "title":  "主结论",         // 可选：标题
  "sections": [              // 可选：多段正文
    { "kind": "statement", "body": "正文，可引用 [SRC] 或 S1。" },
    { "kind": "proof",     "body": "折叠展开的细节 / 证明。" }
  ],
  "anchors": [               // 可选：本节点暴露的可被引用锚点
    { "id": "C1",  "kind": "node",     "number": "1" },
    { "id": "eq1", "kind": "equation", "number": "1" }
  ],
  "refs": [                  // 可选：本节点对外的引用
    { "target": "S1",  "relation": "ref",  "where": "statement" },
    { "target": "SRC", "relation": "cite", "where": "statement" }
  ]
}
```

字段语义：

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | 是 | 唯一标识。引用、锚点都用它互相指向。 |
| `type` | 是 | 对应 `types[].id`。决定配色与是否叶子。 |
| `number` | 否 | 显示用序号。 |
| `title` | 否 | 标题。 |
| `sections[]` | 否 | 多段正文。`kind` 为 `statement` 的段作为主体显示，`proof` 段默认折叠。其它 kind 由 profile 的 `statementKinds` / `proofKinds` 决定归属。 |
| `sections[].body` | — | 正文内容，按 `meta.bodyFormat` 渲染（latex 用 KaTeX，markdown/text 按文本）。 |
| `anchors[]` | 否 | 本节点可被引用的“锚点”。**至少应含一个 id 等于节点 id 的锚点**（适配器会自动补上）。公式、子条目等可作为额外锚点，关系箭头会精确指向其位置。 |
| `refs[]` | 否 | 本节点引用了谁。`target` 指向某个 anchor 的 id；适配器据此解析归属节点并生成边。 |
| `refs[].relation` | 否 | 对应 `relations[].id`，决定引用显示格式；缺省用 profile 默认。 |
| `refs[].where` | 否 | `statement` 或 `proof`，标记引用出现在主体还是折叠区。 |
| `refs[].internal` | 否 | 是否自引用（指向本节点锚点）。缺省自动推断；自引用不生成跨节点边。 |

正文中的可交互引用仍使用轻量 LaTeX 写法：`\\ref{S1}`、`\\eqref{eq1}`、`\\cite{SRC}`。
`refs[]` 负责生成图结构边；正文里的这些命令负责生成 modal 内可 hover/click 的引用文本。
两者的 `target` / `{...}` 应保持一致。

---

## 3. 边（edges）从何而来

通用格式**不需要手写 edges**。适配器会扫描每个节点的 `refs[]`，对每条“跨节点引用”
生成一条有向边：

```
from = 被引用方节点（refs.target 所属节点）
to   = 引用方节点（当前节点）
fromLabel = refs.target（具体锚点，用于箭头精确定位）
```

方向约定与论文一致：`A.anchor --> B` 表示 **“A 被 B 使用”**（A 是 B 的依赖）。
重要度评分 `I(n) = 出度(n) + Σ 依赖的重要度`，圆越大表示被越多结论依赖。

---

## 4. 内置 profile

| profile | 适用 | 默认类型 | 正文格式 |
|---------|------|----------|----------|
| `paper`（默认） | 数学/学术论文 | theorem / proposition / lemma / bib(叶) | latex |
| `generic` | 通用关系结构 | primary / node / support / source(叶) | markdown |

不指定 `meta.profile` 时按 `paper`。你也可以完全用自定义 `types` / `relations` 覆盖。

---

## 5. 最小可用示例

见同目录的 [`../src/data/graph.example.json`](../src/data/graph.example.json)。
把它的内容写入 `src/data/paper-graph.json` 即可直接预览。

---

## 6. 给 LLM 的转换提示词模板

> 你是一个数据转换器。请把下面的材料抽象成 `relation-graph@1` JSON：
> 1. 识别其中的**实体**（每个可独立引用的单元）作为 `nodes`，给每个分配稳定 `id`。
> 2. 为每个实体选择 `type`（若不确定用 `generic` profile 的 primary/support/source）。
> 3. 实体正文放入 `sections`（主体用 `statement`，可折叠的细节用 `proof`）。
> 4. 找出实体之间的**引用/依赖**，写入引用方的 `refs[]`，`target` 指向被引用实体的 `id`。
> 5. 外部不可展开的“来源/出处”用叶子类型（leaf:true），只放标题。
> 6. 不要手写 `edges`，它会自动从 `refs` 推导。
> 7. 输出单个 JSON 对象，含 `format/meta/types/relations/nodes`，保证 `id` 唯一、
>    所有 `refs.target` 能在某个节点的 `anchors`（或节点 id）中找到。

---

## 7. 与旧论文格式的关系

旧的 `paper-graph.json`（含 `statementBody` / `proofBody` / `labels[]` / `refs[].cmd`）
被视为**已编译的运行时格式**，仍可直接使用，无需改动。适配器会自动识别两种输入：

- 含 `format: "relation-graph@1"` 或节点带 `sections/anchors` → 走通用编译。
- 否则 → 视为已编译格式，原样透传。
