# 压力测试结果（test 分支）

生成器：`scripts/gen-stress.mjs`（多形态：dag / chain / star / cycle；规模 200–2000 节点）。
运行：`npx vite-node scripts/gen-stress.mjs`。

## 数据层 · buildModel（Node / vite-node，3 次均值）

| shape | N | edges | buildModel(ms) | hasCycle | maxImportance |
|------|----|-------|----------------|----------|---------------|
| dag  | 200  | 366  | 0.55 | false | 7570   |
| dag  | 500  | 972  | 2.11 | false | 11514  |
| dag  | 1000 | 1969 | 2.28 | false | 74641  |
| dag  | 2000 | 3991 | 4.10 | false | 247385 |
| chain| 2000 | 1999 | 2.80 | false | 1999   |
| star | 2000 | 1999 | 2.84 | false | 1999   |
| cycle| 2000 | 2000 | 2.43 | true  | 2      |

**结论**：`buildModel`（索引 + Tarjan SCC + importance 递归 + 半径映射）随 V+E **近线性**，2000 节点各形态均 **<5ms**，数据层无性能瓶颈，无需优化。

**观察（非性能，记录为建议）**：DAG 上 importance `I(n)=degOut+ΣI(deps)` 会随深度累加，`maxImportance` 在大图迅速膨胀（247k@2000）。半径用 `sqrt(I)/sqrt(maxI)` 归一时，超大图多数节点趋近 `RMIN`，重要度区分度下降。正常论文规模（数十节点）无影响；若未来支持超大图，建议半径归一改用 `log` 或百分位。

## 渲染层 · 多卡片 + 重新布局（CDP / dev）

场景：展开全部 22 个非叶节点为卡片 → `show-modals-only` → `reheat(0.95)`，76 条关系。

- reheat 期间长任务：`[454, 101] ms`（**仅 reheat 瞬间一次性**，随后冷却流畅）。
- 正常使用（同时展开 ≤10 卡片）无长帧。

**已落地的渲染优化**（第 1 项 trace 驱动，见 plan）：
- `forceGraph._anchorWorld` 改用缓存 `node.mw/mh`，消除每 tick 强制重排（边/箭头渲染约 6.2×）。
- `refLayer.updateRelations` 每帧缓存 `getBoundingClientRect`/`querySelector`（`_grc`/`_q`）+ SVG 元素池复用，调用减半。

**阈值建议**：同时展开卡片 ≤ ~15 个时流畅；更多时 reheat 瞬间会出现一次性长帧（22 卡片约 0.45s）。如需支撑更大规模，后续可对关系箭头层在高 alpha 期做节流（每 N tick 重绘）或视口裁剪只画可见关系——属边际优化，当前正常用法不触发。
