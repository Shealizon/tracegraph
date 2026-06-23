# 卡片内「文字段 / 位置」打标设计（Span / Position Tags）

在「整卡片打标」之外，标签成员可指向卡片正文里的**具体文字段**或**具体位置**，并可一键跳转。

## 1. 数据模型（扩展 tag.members）

`tag.members` 的元素从「纯 nodeId 字符串」扩展为**字符串或对象**：

```jsonc
"members": [
  "thm:main",                                            // 整卡片（旧，兼容）
  { "node": "thm:main", "type": "span",                  // 文字段
    "section": "statement", "start": 12, "end": 48, "text": "…原文…" },
  { "node": "lem:1", "type": "pos", "x": 0.5, "y": 0.3 }  // 位置（相对卡片正文 0–1）
]
```

- `type` 缺省/字符串 = `node`。
- 跨文档唯一化（compileProject）时，对象成员的 `node` 字段同样重映射。
- 有序标签里**每个成员**（不论 node/span/pos）按序得到 Step N。

辅助：`memberNodeId(m)` = 取成员所属 nodeId；`memberKey(m)` = 稳定 key。

## 2. 渲染

| 类型 | 渲染 |
|---|---|
| node | 节点圆 / 卡片旁的 Step·图标贴片（现有 #tag-layer） |
| span | 文字下方**虚线**（类 PDF 标注）+ 末尾**tag 贴片**；随卡片正文滚动/移动 |
| pos | 在卡片正文该位置**pin** 一个 tag 贴片 |

- span/pos 贴片与普通贴片**同样式 + 同长按快捷菜单**（全览 / 有序的 ◀▶）。
- span 用 `Range.getClientRects()` 画每行下方虚线；贴片定位在最后一行末尾。
- 定位层：卡片内一个不随 LOD 淡出的覆盖层（或复用 #tag-layer，按卡片 body 滚动裁剪）。

## 3. 交互

### 打标模式（ctx.tagEditing）
- hover 卡片 → `modal-body`（含 collapsed）上盖一层**半透明遮罩**，正中两行：
  「单击操作整体卡片标签」/「双击操作具体位置标签」（遮罩 `pointer-events:none`，仅提示）。
- **单击**正文（无选区）→ 整卡片打标（切换 node 成员）。
- **双击**正文 → 在点击处建 `pos` 成员（阻止默认选词）。
- **拖动选中一段文字**（mouseup 有非空选区）→ 自动建 `span` 成员（无需再确认）。

### 非打标模式 · 右键正文空白/未选中处 → `menu-blank`（图标+文字）
复制（▸ 二级：所有内容/标题/选中）· 固定 · 关闭为节点 · 隐藏 · 常用 3 标签 · 「更多标签此处打标」(location 图标, ▸ 二级所有标签)。

### 选中文字 → `simple-menu`（横向、仅图标，位置=选区末字符处）
图标：复制(选中文字) · 最近用过的 3 个标签 · 省略号(▸ 其余标签二级)。
- 有序标签项显示 `当前数 n+1` 的 tm-idx；**hover ≥1.5s** → 其下展开一行「插入序号」：
  左=即将插入的 tm-idx（实时），分隔线，右=1..n 的 tm-idx（只读）；光标落在**间隙**显竖直长条，
  点击即在该处插入。
- 选区末字符处创建；光标离开一定距离 / 点击别处即消失；除非重新选字否则不再出现。
- 右键选中处：关闭 simple-menu，在光标处生成普通 menu（图标+文字）：常用 3 标签 + 「更多标签文字打标」(alphabet 图标)。

「常用 3 标签」「最近 3 标签」= 最近一次打标用过的标签（LRU，存 `ctx._recentTags`）。

## 4. 选区配色（#4）
取消默认蓝色选区底色，`modal-body ::selection` 用卡片 `--modal-color`（type 色）。

## 5. 跳转
点击 span/pos 贴片 / 全览的成员 → focusNode + 打开卡片 + `scrollIntoView` 到该 span/pos（span 用 Range，pos 用相对坐标）。

## 实施阶段
A 选区配色 · B 打标遮罩 · C 数据模型(对象成员+remap+全览/focus 适配) · D 选中自动打标/双击位置/单击整卡 ·
E span 虚线+贴片渲染 · F simple-menu(含插入行) · G menu-blank / 右键选中 menu · H span/pos 贴片长按菜单 + 跳转。
