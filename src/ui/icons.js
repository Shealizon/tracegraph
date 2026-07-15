// =============================================================================
// ui/icons.js  —  统一 SVG 图标（line 风格，currentColor）
// =============================================================================
const S = (paths, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${paths}</svg>`;

export const ICON = {
  // 切回节点（圆）
  circle: S('<circle cx="12" cy="12" r="7"/>'),
  // 卡片 / 节点（单个 + 多个堆叠，堆叠用偏移的局部路径形成图层遮挡）
  card: S('<rect x="4" y="4" width="16" height="16" rx="2"/><line x1="4" y1="9" x2="20" y2="9"/>'),
  copy: S('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>'),
  edit: S('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/>'),
  undo: S('<polyline points="9 7 4 12 9 17"/><path d="M4 12h8.5A7.5 7.5 0 0 1 20 19.5"/>'),
  aiAdd: S('<path d="M9 3l1.2 3.8L14 8l-3.8 1.2L9 13l-1.2-3.8L4 8l3.8-1.2L9 3z"/><path d="M15.5 11v6M12.5 14h6"/>'),
  // 卡片 + 对角引用箭头：refDeps=引用(↙ 指入)，refUsed=被引(↗ 指出)
  refDeps: S('<rect x="3" y="3" width="18" height="18" rx="3"/><line x1="15.5" y1="8.5" x2="9" y2="15"/><polyline points="9 10 9 15 14 15"/>'),
  refUsed: S('<rect x="3" y="3" width="18" height="18" rx="3"/><line x1="8.5" y1="15.5" x2="15" y2="9"/><polyline points="10 9 15 9 15 14"/>'),
  cards: S('<path d="M4 16 V6 a2 2 0 0 1 2-2 h10"/><rect x="7" y="7" width="13" height="13" rx="2"/><line x1="7" y1="11" x2="20" y2="11"/>'),
  nodes: S('<path d="M5 10 A5 5 0 0 1 13.5 6.5"/><circle cx="14" cy="14" r="5"/>'),
  // 标签相关
  location: S('<path d="M12 21s-6-5.2-6-10a6 6 0 0 1 12 0c0 4.8-6 10-6 10Z"/><circle cx="12" cy="11" r="2.2"/>'),
  alphabet: S('<polyline points="4 8 4 5 20 5 20 8"/><line x1="12" y1="5" x2="12" y2="19"/><line x1="9.5" y1="19" x2="14.5" y2="19"/>'),
  eye: S('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'),
  route: S('<circle cx="6" cy="19" r="2.4"/><circle cx="18" cy="5" r="2.4"/><path d="M8.4 19H14a3 3 0 0 0 0-6H10a3 3 0 0 1 0-6h5.6"/>'),
  tag: S('<path d="M3 11.5 11.5 3H20a1 1 0 0 1 1 1v8.5L12.5 21a1 1 0 0 1-1.4 0L3 12.9a1 1 0 0 1 0-1.4Z"/><circle cx="16.5" cy="7.5" r="1.3" fill="currentColor" stroke="none"/>'),
  star: S('<polygon points="12 3 14.7 8.6 21 9.3 16.5 13.6 17.6 19.8 12 16.8 6.4 19.8 7.5 13.6 3 9.3 9.3 8.6"/>'),
  heart: S('<path d="M12 20s-7-4.3-9.2-8.4C1.4 8.9 2.6 5.8 5.6 5.2 7.7 4.8 9.7 6 12 8.6c2.3-2.6 4.3-3.8 6.4-3.4 3 .6 4.2 3.7 2.8 6.4C19 15.7 12 20 12 20Z"/>'),
  bookmark: S('<path d="M6 4h12a1 1 0 0 1 1 1v15l-7-4-7 4V5a1 1 0 0 1 1-1Z"/>'),
  flag: S('<path d="M5 21V4"/><path d="M5 4h11l-1.5 3.5L16 11H5"/>'),
  listOrdered: S('<line x1="10" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="10" y1="18" x2="20" y2="18"/><path d="M4 6h2v4M4 10h3" stroke-width="1.6"/>'),
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
  note: S('<path d="M5 4h14v16H5z"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="13" y2="16"/>'),
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
  chevronRight: S('<polyline points="9 6 15 12 9 18"/>'),
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
  link: S('<path d="M10 13a5 5 0 0 0 7.1.1l2-2A5 5 0 0 0 12 4l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1"/>'),
};
