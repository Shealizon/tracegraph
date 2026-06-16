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
};
