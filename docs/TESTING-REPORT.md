# 测试与性能检测报告

检测日期：2026-07-17

## 当前基线

- `npm run test:run`：31 个测试文件，217 个用例，通过。
- `npm run build`：通过。
- `npm run coverage`：通过；当前覆盖率统计范围为 `src/data/**`、`src/import/**`、`src/model/**`、`src/project/**`。
- `node scripts/smoke-render.mjs`：`text segs=1304`，`math segs=1271`，`errors=0`。
- `npm run verify:extensions`：`pdf-workbench` ready；`paddle-ocr` ready=false，依赖外部 OCR 配置。

## 覆盖情况

| 区域 | 行覆盖 | 分支覆盖 | 备注 |
| --- | ---: | ---: | --- |
| data | 91.35% | 67.07% | schema / reference 的异常分支仍可补充 |
| import | 95.01% | 63.33% | TeX 解析边界分支仍可补充 |
| model | 100% | 73.68% | 图谱核心逻辑覆盖较充分 |
| project | 88.21% | 54.54% | 多文档、禁用项、编辑分支仍可补充 |

## 新增测试入口

- `npm run test:perf`：稳定种子的节点图谱性能回归检查，通过 `vite-node` 执行以匹配项目的 JSON import 运行环境。
- 覆盖图谱形态：`dag`、`chain`、`star`、`cycle`。
- 默认规模：1000 和 4000 节点。
- 指标：`buildModel` 多次运行中位数与预算比较。

当前运行结果：

| shape | nodes | edges | medianMs | budgetMs | hasCycle |
| --- | ---: | ---: | ---: | ---: | --- |
| dag | 1000 | 2477 | 5.12 | 40 | false |
| dag | 4000 | 10029 | 18.12 | 220 | false |
| chain | 4000 | 3999 | 9.26 | 120 | false |
| star | 4000 | 3999 | 8.36 | 120 | false |
| cycle | 4000 | 4000 | 14.21 | 120 | true |

## 异常报告

### A-001：压力测试脚本不适合作为稳定门禁

- 位置：`scripts/gen-stress.mjs`
- 现象：DAG 数据使用 `Math.random()`；脚本固定写入 `C:/temp/stress-graph.json`。
- 影响：不同机器、不同运行之间结果不可完全复现；非 Windows 或无 `C:/temp` 环境会失败。
- 状态：未修复。已新增独立 `test:perf` 入口用于稳定回归。

### A-002：覆盖率统计范围未纳入 UI / AI / cloud / server 多数模块

- 位置：`vitest.config.js`
- 现象：coverage include 仅包含纯逻辑层。
- 影响：已有 UI、AI、cloud、server 测试会执行，但覆盖率报表不会显示这些模块的缺口。
- 状态：未修复。建议后续按模块分阶段扩大覆盖率统计，避免一次性引入过多噪声。

### A-003：`paddle-ocr` 扩展未处于 ready 状态

- 位置：`extensions/builtin/paddle-ocr`
- 现象：扩展验证报告中 `ready=false`。
- 影响：OCR 相关能力在当前环境不可作为通过门禁。
- 状态：未修复。需要确认 `PADDLEOCR_TOKEN` 与工具依赖安装策略。

## 后续测试建议

- 节点图谱：保留 `test:perf` 作为数据层性能门禁；渲染层继续使用 CDP 脚本按展开卡片数、边数量、reheat 场景记录长任务。
- 项目模块：补多文档 id 冲突、跨文档引用、禁用节点和禁用边组合测试。
- AI 模块：补工具调用参数非法、上下文预算截断、附件权限边界测试。
- 服务端模块：补 API 层鉴权失败、跨用户访问隔离、vault 损坏恢复测试。
- UI 模块：补关键交互的 jsdom 或 CDP 回归，包括侧栏过滤、标签编辑、节点编辑、全屏详情。
