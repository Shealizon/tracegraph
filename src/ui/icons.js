// =============================================================================
// ui/icons.js  —  统一 SVG 图标（line 风格，currentColor）
// =============================================================================
const S = (paths, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${paths}</svg>`;

export const ICON = {
  // 切回节点（圆）
  circle: S('<circle cx="12" cy="12" r="7"/>'),
  // 展开"使用本结论者"（向右上箭头）
  arrowUpRight: S('<line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/>'),
  // 展开"依赖"（向左下箭头）
  arrowDownLeft: S('<line x1="17" y1="7" x2="7" y2="17"/><polyline points="17 17 7 17 7 7"/>'),
  // 展开"使用本结论者"：左侧实心圆点 + 右侧左箭头指向圆点（被引用 ← 使用者）
  arrowUsed: S('<circle cx="5" cy="12" r="2.6" fill="currentColor" stroke="none"/><line x1="21" y1="12" x2="9" y2="12"/><polyline points="13 8 9 12 13 16"/>'),
  // 展开"本结论的依赖"：左侧空心圆点 + 右侧右箭头背向圆点（本结论 → 所依赖）
  arrowDeps: S('<circle cx="5" cy="12" r="2.6"/><line x1="9" y1="12" x2="21" y2="12"/><polyline points="17 8 21 12 17 16"/>'),
  // 文献/论文（带折角的文档）
  fileText: S('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="16" x2="13" y2="16"/>'),
  // 隐藏（眼睛划线）
  eyeOff: S('<path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><path d="M6.61 6.61A18.5 18.5 0 0 0 2 12s3 8 10 8a9.12 9.12 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/>'),
  // 详情（全屏展开）
  expand: S('<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>'),
  // 固定（图钉）
  pin: S('<line x1="12" y1="17" x2="12" y2="22"/><path d="M9 3h6l-1 7 3 3H7l3-3-1-7z"/>'),
  // 关闭
  close: S('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  // 折叠/展开三角（向下=可展开，向上=可收起）
  chevronDown: S('<polyline points="6 9 12 15 18 9"/>'),
  chevronUp: S('<polyline points="6 15 12 9 18 15"/>'),
  // 主题：太阳 / 月亮 / 显示器（跟随系统）
  sun: S('<circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.2" y1="4.2" x2="5.6" y2="5.6"/><line x1="18.4" y1="18.4" x2="19.8" y2="19.8"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.2" y1="19.8" x2="5.6" y2="18.4"/><line x1="18.4" y1="5.6" x2="19.8" y2="4.2"/>'),
  moon: S('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  monitor: S('<rect x="3" y="4" width="18" height="13" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>'),
  home: S('<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10.5V20h5v-5h4v5h5v-9.5"/>'),
  settings: S('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6V20a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-.6 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1H4a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 .6-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6V4a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 .6 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.22.34.42.68.6 1h.1a2 2 0 1 1 0 4H20a1.7 1.7 0 0 0-.6 1z"/>'),
  upload: S('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'),
  download: S('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
  trash: S('<polyline points="3 6 5 6 21 6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>'),
  plus: S('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  play: S('<polygon points="8 5 19 12 8 19 8 5"/>'),
  // 勾选（toggle-row 选中态）
  check: S('<polyline points="20 6 9 17 4 12"/>'),
  // 溢出菜单（竖向三点）
  more: S('<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>', 'fill="currentColor" stroke="none"'),
  // 搜索
  search: S('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  // 信息（文档信息按钮）
  info: S('<circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><circle cx="12" cy="7.8" r="1" fill="currentColor" stroke="none"/>'),
  // 重新布局（循环箭头）
  reload: S('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'),
  // 折叠为节点（向内收拢）
  collapse: S('<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>'),
  // 吸附链接（两环相扣）
  link: S('<path d="M9 12a3 3 0 0 1 3-3h3a3 3 0 0 1 0 6h-1.5"/><path d="M15 12a3 3 0 0 1-3 3H9a3 3 0 0 1 0-6h1.5"/>'),
};
