// =============================================================================
// view/modal.js  —  节点 ↔ modal
// =============================================================================
import { ICON } from '../ui/icons.js';
import { isLeafNode, nodeTag, paperName, typeColor } from '../data/schema.js';

const DEFAULT_W = 380;
const A4 = 1.414;
let CUR_W = DEFAULT_W;                 // 当前 modal 宽度（可由侧栏滑块调节 —— N7）
const maxH = () => Math.round(CUR_W * A4);

export const MODAL_W = DEFAULT_W;
export const MAX_H = Math.round(DEFAULT_W * A4);

// 顶部按钮配置：内容操作成组在前，破坏性「隐藏」与「切回节点」分到右侧（N3）
const TOP_BUTTONS = [
  { act: 'open-used', title: '展开使用本结论者', icon: 'arrowUsed' },
  { act: 'open-deps', title: '展开本结论的依赖', icon: 'arrowDeps' },
  { act: 'details', title: '详情', icon: 'expand' },
  { act: 'pin', title: '锁定位置', icon: 'pin' },
  { act: 'hide', title: '隐藏此节点', icon: 'eyeOff', tone: 'danger', sep: true },
  { act: 'to-node', title: '切回节点', icon: 'circle' },
];

// -----------------------------------------------------------------------------
// 共享：构建 modal 外壳（正常 modal 与 hover 预览复用 —— N6）
//   opts: { type, titleHTML, bodyHTML, buttons, foot, preview }
// -----------------------------------------------------------------------------
export function buildModalShell(opts) {
  const el = document.createElement('div');
  el.className = `modal type-${opts.type || ''}${opts.preview ? ' preview' : ''}`;
  el.style.width = `${CUR_W}px`;
  if (opts.color) el.style.setProperty('--modal-color', opts.color);
  const btns = (opts.buttons || []).map((b) => `<button class="m-btn${b.tone === 'danger' ? ' m-btn-danger' : ''}${b.sep ? ' m-sep' : ''}" data-act="${b.act}" title="${b.title}">${ICON[b.icon] || ''}</button>`).join('');
  el.innerHTML = `
    <div class="modal-top">
      <span class="m-title">${opts.titleHTML || ''}</span>
      ${btns}
    </div>
    ${opts.subHTML ? `<div class="m-sub">${opts.subHTML}</div>` : ''}
    <div class="modal-body${opts.collapsed ? ' collapsed' : ''}">${opts.bodyHTML || ''}</div>
    ${opts.foot ? `<div class="modal-foot">${ICON.chevronDown}<span>展开${escapeHtml(opts.footLabel || '详情')}</span></div>` : ''}`;
  return el;
}

// 限高：自然高度超过 maxH 时让 body 滚动（正常/预览共用 —— N6）
export function applyHeightCap(el) {
  const body = el.querySelector('.modal-body');
  if (!body) return;
  body.style.maxHeight = '';
  const topH = el.querySelector('.modal-top')?.offsetHeight || 0;
  const footH = el.querySelector('.modal-foot')?.offsetHeight || 0;
  if (el.offsetHeight > maxH()) body.style.maxHeight = `${maxH() - topH - footH}px`;
}

export function titleHTML(node) {
  return `<span class="m-num">${escapeHtml(nodeTag(window.__ctx?.model, node))}</span> · ${escapeHtml(node.title || '')}`;
}

export class ModalManager {
  constructor(ctx, { overlayEl, stageEl }) {
    this.ctx = ctx;
    this.overlayEl = overlayEl;
    this.stageEl = stageEl;
    this.open = new Map();
    ctx.graph.setOverlaySync(() => this._syncPositions());
  }

  isOpen(nodeId) { return this.open.has(nodeId); }

  // 调节 modal 宽度（N7）：更新常量并实时套用到所有已开 modal
  setWidth(w) {
    CUR_W = Math.round(w);
    for (const rec of this.open.values()) {
      rec.el.style.width = `${CUR_W}px`;
      rec.node.mw = CUR_W;
      // 临时清掉显式高度以测量自然高度，再据当前 LOD 还原
      const savedH = rec.el.style.height;
      rec.el.style.height = '';
      applyHeightCap(rec.el);
      rec._naturalH = Math.min(rec.el.offsetHeight, maxH());
      rec.el.style.height = savedH;
      rec.node.mh = rec._naturalH;
    }
    this.applyLod(this.ctx.graph._lod || 0); // 远景下重算正方形边长 + 同步位置
    this.ctx.graph.reheat(0.3);
  }
  getWidth() { return CUR_W; }

  // 切换 pin（锁定位置）：节点 / 卡片 / LOD 卡片通用（PR1）。解锁时断开吸附关系。
  togglePin(node) {
    node.pinned = !node.pinned;
    if (node.pinned) { node.fx = node.x; node.fy = node.y; }
    else if (!node.isModal) { node.fx = null; node.fy = null; }
    this._syncPinUI(node);
    this._applyPinClass(node);
    this.ctx.pushUndo && this.ctx.pushUndo({ undo: () => this.togglePin(node) });
    this.ctx.writeHash && this.ctx.writeHash();
  }
  // pin 按钮高亮态
  _syncPinUI(node) {
    const rec = this.open.get(node.id);
    if (!rec) return;
    const pb = rec.el.querySelector('[data-act="pin"]');
    if (pb) { pb.classList.toggle('is-active', !!node.pinned); pb.title = node.pinned ? '已锁定位置（点击解锁）' : '锁定位置'; }
  }
  // pin 光晕：节点圆 + 卡片都套对应颜色光晕（PR1）
  _applyPinClass(node) {
    const circle = this.ctx.graph.nodeEls.get(node.id);
    if (circle) circle.classList.toggle('pinned', !!node.pinned);
    const rec = this.open.get(node.id);
    if (rec) rec.el.classList.toggle('pinned', !!node.pinned);
  }
  // 程序化 pin（如「按主线排列」）后同步按钮高亮 + 光晕
  reflectPin(node) { this._syncPinUI(node); this._applyPinClass(node); }

  // 远景 LOD：把每个展开框高度在「自然高度」与「正方形(边长=宽度)」之间按 lod 插值，
  // 过渡区间随缩放连续动画；lod=1 时为正方形 LOD-modal。
  applyLod(lod) {
    let changed = false;
    for (const rec of this.open.values()) {
      const side = rec.node.mw || CUR_W;
      const natural = rec._naturalH || rec.node.mh || rec.el.offsetHeight || maxH();
      const next = lod <= 0.001 ? natural : Math.round(natural + (side - natural) * lod);
      if (next !== rec.node.mh) changed = true;
      rec.el.style.height = lod <= 0.001 ? '' : `${next}px`;
      rec.node.mh = next;
    }
    this._syncPositions();
    // 卡片高度随缩放（LOD）变化 → 让力学按新尺寸即时更新碰撞/排斥体积，
    // 否则卡片要等到拖拽才会重新分开。保持 sim 轻微 warm，过渡停止后自然冷却。
    if (changed && this.open.size) {
      const g = this.ctx.graph;
      g.reheat(Math.max(g.sim.alpha(), 0.2));
    }
  }

  openFromNode(node, opts = {}) {
    if (isLeafNode(this.ctx.model, node)) { this.ctx.openDetails(node.id); return; }
    if (this.open.has(node.id)) {
      const rec = this.open.get(node.id);
      this._pulse(node.id);
      this._applyOpenOptions(rec, opts);
      return rec;
    }

    const rec = this._createModal(node);
    this.open.set(node.id, rec);
    this.reflectPin(node); // 初次挂载即同步 pin 按钮高亮 + 光晕（节点可能已被排列/手动 pin）

    node.isModal = true;
    node.mw = CUR_W;
    node.mh = rec.el.offsetHeight || maxH();
    // PR4：卡片以「左上角」作为定位锚点。入参 opts.x/y 语义为中心 → 转为左上角存储。
    const cx = opts.x != null ? opts.x : node.x;
    const cy = opts.y != null ? opts.y : node.y;
    const spot = this._avoidOverlap(cx - node.mw / 2, cy - node.mh / 2, node);
    node.x = node.fx = spot.x;
    node.y = node.fy = spot.y;
    node._anchorResolver = (labelId, kind) => this._anchorWorld(node, rec, labelId, kind);

    const circle = this.ctx.graph.nodeEls.get(node.id);
    if (circle) circle.classList.add('is-modal-origin');

    this.ctx.graph.updateVisibility();
    // 仅轻微 warm：保留现有布局，只让新卡片与邻近元素就地适应，不做全局重排
    this.ctx.graph.reheat(0.2);
    this._syncPositions();
    this.ctx.refLayer.refreshRelations();
    this._applyOpenOptions(rec, opts);
    this.ctx.writeHash && this.ctx.writeHash();
    // 结构操作撤销：新展开一个卡片 → 撤销即把它折回节点（N7）
    if (!this.ctx._undoing && !this.ctx._restoring) {
      if (this.ctx._batch) this.ctx._batch.push(node.id);
      else this.ctx.pushUndo && this.ctx.pushUndo({ undo: () => this.closeModal(node.id) });
    }
    return rec;
  }

  // 折回节点（带撤销）：撤销时在原位重新展开，并恢复证明展开/锁定状态（N7）
  _collapseWithUndo(node, rec) {
    const snap = { x: node.x + (node.mw || 0) / 2, y: node.y + (node.mh || 0) / 2, collapsed: rec.collapsed, pinned: node.pinned };
    this.ctx.pushUndo && this.ctx.pushUndo({ undo: () => {
      const r = this.openFromNode(node, { x: snap.x, y: snap.y });
      if (r) { node.pinned = snap.pinned; node.fx = node.x; node.fy = node.y; if (!snap.collapsed && r.expandProof) r.expandProof(); }
    } });
    this.closeModal(node.id);
  }

  _findFreeSpot(node, opts) {
    if (opts.x != null && opts.y != null) return this._avoidOverlap(opts.x, opts.y, node);
    return this._avoidOverlap(node.x ?? 0, node.y ?? 0, node);
  }
  _avoidOverlap(x0, y0, self) {
    const others = [...this.open.values()].map((r) => r.node).filter((n) => n !== self && n.isModal);
    const minDX = CUR_W + 40;
    const minDY = maxH() * 0.45 + 50;
    const fits = (x, y) => others.every((o) => Math.abs(o.x - x) >= minDX || Math.abs(o.y - y) >= minDY);
    if (fits(x0, y0)) return { x: x0, y: y0 };
    for (let t = 1; t <= 60; t++) {
      const ang = t * 0.9;
      const rad = 70 + t * 40;
      const x = x0 + Math.cos(ang) * rad;
      const y = y0 + Math.sin(ang) * rad;
      if (fits(x, y)) return { x, y };
    }
    return { x: x0, y: y0 };
  }

  openBeside(node, originNode, side = 'right', opts = {}) {
    if (this.open.has(node.id)) {
      const rec = this.open.get(node.id);
      this._pulse(node.id);
      this._applyOpenOptions(rec, opts);
      return rec;
    }
    const dir = side === 'left' ? -1 : 1;
    // origin 若已是卡片，其 x/y 为左上角 → 换算到中心再并排（PR4）
    const ocx = (originNode.x || 0) + (originNode.isModal ? (originNode.mw || CUR_W) / 2 : 0);
    const ocy = (originNode.y || 0) + (originNode.isModal ? (originNode.mh || 0) / 2 : 0);
    const x = ocx + dir * (CUR_W + 70);
    const y = ocy;
    return this.openFromNode(node, { ...opts, x, y });
  }

  closeModal(nodeId) {
    const rec = this.open.get(nodeId);
    if (!rec) return;
    const node = rec.node;
    rec.el.remove();
    this.open.delete(nodeId);
    node.isModal = false;
    // PR4：左上角 → 中心，让退化后的圆回到卡片中心处
    if (node.mw && node.mh) { node.x = node.x + node.mw / 2; node.y = node.y + node.mh / 2; }
    node.mw = node.mh = 0;
    node._anchorResolver = null;
    if (node.pinned) { node.fx = node.x; node.fy = node.y; }
    else { node.fx = null; node.fy = null; }
    const circle = this.ctx.graph.nodeEls.get(nodeId);
    if (circle) circle.classList.remove('is-modal-origin');
    this.ctx.graph.updateVisibility();
    this.ctx.refLayer.refreshRelations();
    // 折回节点也只轻微 warm：保留其余元素位置，仅让腾出的空间被邻近元素就地填补
    this.ctx.graph.reheat(0.15);
    this.ctx.graph._tick();
    this.ctx.writeHash && this.ctx.writeHash();
  }

  closeAll() {
    const snap = [...this.open.values()].map((r) => ({ id: r.node.id, x: r.node.x + (r.node.mw || 0) / 2, y: r.node.y + (r.node.mh || 0) / 2, collapsed: r.collapsed, pinned: r.node.pinned }));
    for (const id of [...this.open.keys()]) this.closeModal(id);
    this.ctx.refLayer.clear();
    if (snap.length && this.ctx.pushUndo && !this.ctx._undoing) {
      this.ctx.pushUndo({ undo: () => snap.forEach((s) => {
        const n = this.ctx.model.nodeById.get(s.id);
        if (!n) return;
        const r = this.openFromNode(n, { x: s.x, y: s.y });
        if (r) { n.pinned = s.pinned; n.fx = n.x; n.fy = n.y; if (!s.collapsed && r.expandProof) r.expandProof(); }
      }) });
    }
  }

  // 折叠所有已展开卡片的证明（仅作用于含证明的 modal）
  collapseAllProofs() {
    const expanded = [];
    for (const rec of this.open.values()) {
      if (rec.hasProof && !rec.collapsed) { expanded.push(rec.node.id); rec.setProofCollapsed(true); }
    }
    if (expanded.length && this.ctx.pushUndo && !this.ctx._undoing) {
      this.ctx.pushUndo({ undo: () => expanded.forEach((id) => { const r = this.open.get(id); if (r && r.expandProof) r.expandProof(); }) });
    }
    return expanded.length;
  }

  onModeChange() {
    this._syncPositions();
    this.ctx.refLayer.refreshRelations();
  }

  // ---- 创建 modal DOM ----
  _createModal(node) {
    const ctx = this.ctx;
    const proofLabel = proofLabelOf(ctx);
    const stmtHtml = ctx.getRendered ? ctx.getRendered(node.id, 'statement') : ctx.render(node.statementBody);
    const proofHtml = node.proofBody ? (ctx.getRendered ? ctx.getRendered(node.id, 'proof') : ctx.render(node.proofBody)) : '';

    const paper = paperName(ctx.model, node);
    const el = buildModalShell({
      type: node.type,
      color: typeColor(ctx.model, node.type),
      titleHTML: titleHTML(node),
      subHTML: paper ? `<span class="m-paper">${ICON.fileText || ''}${escapeHtml(paper)}</span>` : '',
      buttons: TOP_BUTTONS,
      bodyHTML: `<div class="statement">${stmtHtml}</div>${proofHtml ? `<div class="proof-wrap"><div class="proof-label">${escapeHtml(proofLabel)}.</div>${proofHtml}</div>` : ''}`,
      foot: !!proofHtml,
      footLabel: proofLabel,
      collapsed: true, // 默认折叠证明（N1）
    });
    el.dataset.id = node.id;
    // 远景 LOD：尺寸不变，叠加“大号节点”式正面（类型/编号/标题，上下结构大字体），随 --lod 淡入
    const face = document.createElement('div');
    face.className = 'modal-nodeface';
    const mnfNum = String(node.number ?? nodeTag(ctx.model, node));
    face.innerHTML = `<div class="mnf-type">${escapeHtml(node.typeLabel || node.type || '')}</div><div class="mnf-num" style="--num-len:${Math.max(1, mnfNum.length)}">${escapeHtml(mnfNum)}</div>`;
    el.appendChild(face);
    const body = el.querySelector('.modal-body');
    this.overlayEl.appendChild(el);

    requestAnimationFrame(() => {
      applyHeightCap(el);
      node.mh = Math.min(el.offsetHeight, maxH());
      rec._naturalH = node.mh;
      if (this.ctx.graph._lod) this.applyLod(this.ctx.graph._lod); // 远景时新开框直接成正方形
      this._syncPositions();
    });

    // proof 折叠条：向下三角=可展开，向上三角=可收起（N1）
    const foot = el.querySelector('.modal-foot');
    const rec = { el, node, collapsed: true, hasProof: !!foot };
    // 统一的证明折叠/展开：更新高度后 reheat，使碰撞体积立即生效（不必等拖拽）
    rec.setProofCollapsed = (collapsed) => {
      if (!foot || rec.collapsed === collapsed) return;
      rec.collapsed = collapsed;
      body.classList.toggle('collapsed', collapsed);
      foot.innerHTML = collapsed
        ? `${ICON.chevronDown}<span>展开${escapeHtml(proofLabel)}</span>`
        : `${ICON.chevronUp}<span>折叠${escapeHtml(proofLabel)}</span>`;
      requestAnimationFrame(() => {
        applyHeightCap(el);
        node.mh = Math.min(el.offsetHeight, maxH());
        rec._naturalH = node.mh;
        this._syncPositions();
        this.ctx.graph.reheat(0.25);
      });
    };
    rec.expandProof = () => rec.setProofCollapsed(false);
    rec.scrollToLabel = (labelId) => {
      if (!labelId) return;
      requestAnimationFrame(() => {
        const target = el.querySelector(`[data-label="${cssEscape(labelId)}"]`);
        if (target) target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      });
    };

    // 锁定位置（pin）：锁定后不再被力学推动；可解锁（N13 / PR1）
    const pinBtn = el.querySelector('[data-act="pin"]');
    this._syncPinUI(node);
    this._applyPinClass(node);
    pinBtn.addEventListener('click', () => this.togglePin(node));

    el.querySelector('[data-act="to-node"]').addEventListener('click', () => this._collapseWithUndo(node, rec));
    el.querySelector('[data-act="details"]').addEventListener('click', () => this.ctx.openDetails(node.id));
    el.querySelector('[data-act="open-used"]').addEventListener('click', () => this._openRelated(node, 'used'));
    el.querySelector('[data-act="open-deps"]').addEventListener('click', () => this._openRelated(node, 'deps'));
    el.querySelector('[data-act="hide"]').addEventListener('click', () => this.ctx.hideNode(node.id));

    if (foot) foot.addEventListener('click', () => rec.setProofCollapsed(!rec.collapsed));

    // 远景 LOD-modal：双击退化为节点（等价”切回节点”）
    el.addEventListener('dblclick', (ev) => {
      if (!this.ctx.graph.lodFar) return;
      ev.preventDefault();
      ev.stopPropagation();
      this._collapseWithUndo(node, rec);
    });

    body.addEventListener('wheel', (ev) => {
      if (ev.altKey) return; // Alt：让滚轮冒泡到舞台用于全屏缩放（即使卡片有滚动条）
      if (this.ctx.graph && this.ctx.graph.lodFar) return; // 远景形态：让滚轮冒泡用于缩放，不滚动正文
      if (body.scrollHeight > body.clientHeight + 1) ev.stopPropagation();
    }, { passive: true });

    this._attachModalDrag(el, node, rec);
    this.ctx.refLayer.bindRefs(el, node, rec);
    el.addEventListener('mouseenter', () => {
      this.ctx.graph.highlightNeighbors(node.id, true);
      this.ctx.refLayer.highlightModal(node.id, true);
      if (this.ctx.graph.lodFar) this.ctx.refLayer.showNodePreview(el, node); // 远景：hover 显示具体信息
    });
    el.addEventListener('mouseleave', () => {
      this.ctx.graph.highlightNeighbors(node.id, false);
      this.ctx.refLayer.highlightModal(node.id, false);
      this.ctx.refLayer.scheduleNodePreviewClose();
    });
    return rec;
  }

  _applyOpenOptions(rec, opts = {}) {
    if (!rec) return;
    if (opts.expandProof) rec.expandProof && rec.expandProof();
    if (opts.scrollLabel) rec.scrollToLabel && rec.scrollToLabel(opts.scrollLabel);
  }

  _openRelated(node, dir) {
    const set = dir === 'used' ? this.ctx.model.usedBy.get(node.id) : this.ctx.model.deps.get(node.id);
    const list = [...(set || [])].filter((id) => { const t = this.ctx.model.nodeById.get(id); return t && !isLeafNode(this.ctx.model, t) && !this.open.has(id); });
    const scx = node.x + (node.mw || 0) / 2, scy = node.y + (node.mh || 0) / 2; // 源卡片中心（PR4）
    const batch = this.ctx._batch = [];
    list.forEach((id, i) => {
      const tgt = this.ctx.model.nodeById.get(id);
      const ang = (i / Math.max(1, list.length)) * Math.PI * 2;
      const rad = 380 + Math.floor(i / 6) * 120;
      this.openFromNode(tgt, { x: scx + Math.cos(ang) * rad, y: scy + Math.sin(ang) * rad });
    });
    this.ctx._batch = null;
    // 一次展开一组 → 合并为单次撤销（N7）
    if (batch.length && this.ctx.pushUndo && !this.ctx._undoing) {
      this.ctx.pushUndo({ undo: () => batch.forEach((id) => this.closeModal(id)) });
    }
    this.ctx.refLayer.refreshRelations();
  }

  _syncPositions() {
    for (const rec of this.open.values()) {
      const n = rec.node;
      // PR4：n.x/n.y 即卡片左上角世界坐标
      rec.el.style.transform = `translate(${n.x}px, ${n.y}px)`;
    }
    this.ctx.refLayer && this.ctx.refLayer.updateRelations();
  }

  _anchorWorld(node, rec, labelId, kind) {
    // 用缓存尺寸 node.mw/mh，避免每次读 offsetWidth/offsetHeight 触发强制重排（性能热点）
    const w = node.mw || rec.el.offsetWidth || CUR_W;
    const h = node.mh || rec.el.offsetHeight || maxH();
    // PR4：node.x/node.y 为左上角；中心 = +w/2,+h/2
    const left = node.x, top = node.y, right = node.x + w, bottom = node.y + h;
    const cxw = node.x + w / 2, cyw = node.y + h / 2;
    // 远景 LOD-modal：锚点落在边界、规则与 node 一致（label 顶部 / 公式两侧，refs 底部）
    if (this.ctx.graph.lodFar) {
      if (kind === 'refs') return { x: cxw, y: bottom };
      const labels = node.labels || [];
      const lab = labels.find((l) => l.id === labelId);
      if (lab && lab.id !== node.id && lab.kind === 'equation') {
        const eqs = labels.filter((l) => l.kind === 'equation');
        const i = Math.max(0, eqs.findIndex((l) => l.id === lab.id));
        const side = i % 2 === 0 ? -1 : 1;
        const sideIndex = Math.floor(i / 2);
        const countSide = Math.ceil(eqs.length / 2);
        const span = h * 0.6;
        const y = cyw - span / 2 + (countSide <= 1 ? span / 2 : (sideIndex / (countSide - 1)) * span);
        return { x: side < 0 ? left : right, y };
      }
      return { x: cxw, y: top };
    }
    if (kind === 'refs') return { x: left, y: cyw };
    if (labelId === node.id) return { x: cxw, y: top };
    return { x: right, y: cyw };
  }

  // ---- 拖拽：近景仅顶栏；远景（大号节点形态）整卡可拖 ----
  _attachModalDrag(el, node) {
    let sx, sy, ox, oy;
    const onDown = (ev) => {
      if (ev.altKey) return; // Alt：让事件冒泡给舞台做全屏平移，不拖拽卡片
      if (ev.target.closest('.m-btn')) return;
      if (ev.ctrlKey || ev.metaKey) { ev.preventDefault(); ev.stopPropagation(); this.togglePin(node); return; } // Ctrl+点击：pin/解锁
      const far = this.ctx.graph && this.ctx.graph.lodFar;
      if (!far && !ev.target.closest('.modal-top')) return; // 近景：只有顶栏可拖（让正文可选中/滚动）
      ev.preventDefault();
      ev.stopPropagation();
      sx = ev.clientX; sy = ev.clientY; ox = node.x; oy = node.y;
      el.classList.add('dragging');
      el.style.willChange = 'transform'; // 拖拽期间强制图层提升，保证流畅（覆盖 render-sharp）
      node._dragging = true;
      node.fx = node.x; node.fy = node.y;
      this.ctx.graph.sim.alphaTarget(0.05).restart();
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };
    const onMove = (ev) => {
      const k = this.ctx.graph.transform.k;
      node.x = node.fx = ox + (ev.clientX - sx) / k;
      node.y = node.fy = oy + (ev.clientY - sy) / k;
      this._syncPositions();
      this.ctx.graph._renderEdges();
    };
    const onUp = () => {
      el.classList.remove('dragging');
      el.style.willChange = ''; // 还原，使其在缩放停止后可重新栅格化变清晰
      node._dragging = false;
      this.ctx.graph.sim.alphaTarget(0);
      node.fx = node.x; node.fy = node.y;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    el.addEventListener('pointerdown', onDown);
  }

  _pulse(nodeId) {
    const rec = this.open.get(nodeId);
    if (!rec) return;
    const base = rec.el.style.transform;
    rec.el.animate([{ transform: base }, { transform: base + ' scale(1.04)' }, { transform: base }], { duration: 300 });
  }
}

function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function proofLabelOf(ctx) { return ctx.model.meta.proofLabel || '详情'; }
function cssEscape(s) { return String(s).replace(/"/g, '\\"'); }
