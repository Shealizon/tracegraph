// =============================================================================
// view/modal.js  —  节点 ↔ modal
// =============================================================================
import { ICON } from '../ui/icons.js';
import { isLeafNode, nodeTag, typeColor } from '../data/schema.js';

const DEFAULT_W = 380;
const A4 = 1.414;
let CUR_W = DEFAULT_W;                 // 当前 modal 宽度（可由侧栏滑块调节 —— N7）
const maxH = () => Math.round(CUR_W * A4);

export const MODAL_W = DEFAULT_W;
export const MAX_H = Math.round(DEFAULT_W * A4);

// 顶部按钮配置（SVG 图标 —— N3）
const TOP_BUTTONS = [
  { act: 'to-node', title: '切回节点', icon: 'circle' },
  { act: 'open-used', title: '展开使用本结论者', icon: 'arrowUpRight' },
  { act: 'open-deps', title: '展开本结论的依赖', icon: 'arrowDownLeft' },
  { act: 'hide', title: '隐藏此节点', icon: 'eyeOff' },
  { act: 'details', title: '详情', icon: 'expand' },
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
  const btns = (opts.buttons || []).map((b) => `<button class="m-btn" data-act="${b.act}" title="${b.title}">${ICON[b.icon] || ''}</button>`).join('');
  el.innerHTML = `
    <div class="modal-top">
      <span class="m-title">${opts.titleHTML || ''}</span>
      ${btns}
    </div>
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
      applyHeightCap(rec.el);
      rec.node.mh = Math.min(rec.el.offsetHeight, maxH());
    }
    this._syncPositions();
    this.ctx.graph.reheat(0.3);
  }
  getWidth() { return CUR_W; }

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

    node.isModal = true;
    node.mw = CUR_W;
    node.mh = rec.el.offsetHeight || maxH();
    const spot = this._findFreeSpot(node, opts);
    node.x = node.fx = spot.x;
    node.y = node.fy = spot.y;
    node._anchorResolver = (labelId, kind) => this._anchorWorld(node, rec, labelId, kind);

    const circle = this.ctx.graph.nodeEls.get(node.id);
    if (circle) circle.classList.add('is-modal-origin');

    this.ctx.graph.updateVisibility();
    this.ctx.graph.reheat(0.6);
    this._syncPositions();
    this.ctx.refLayer.refreshRelations();
    this._applyOpenOptions(rec, opts);
    this.ctx.writeHash && this.ctx.writeHash();
    return rec;
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
    const x = (originNode.x || 0) + dir * (CUR_W + 70);
    const y = (originNode.y || 0);
    return this.openFromNode(node, { ...opts, x, y });
  }

  closeModal(nodeId) {
    const rec = this.open.get(nodeId);
    if (!rec) return;
    rec.el.remove();
    this.open.delete(nodeId);
    const node = rec.node;
    node.isModal = false;
    node.mw = node.mh = 0;
    node._anchorResolver = null;
    if (!node.pinned) { node.fx = null; node.fy = null; }
    const circle = this.ctx.graph.nodeEls.get(nodeId);
    if (circle) circle.classList.remove('is-modal-origin');
    this.ctx.graph.updateVisibility();
    this.ctx.refLayer.refreshRelations();
    this.ctx.graph.reheat(0.4);
    this.ctx.graph._tick();
    this.ctx.writeHash && this.ctx.writeHash();
  }

  closeAll() {
    for (const id of [...this.open.keys()]) this.closeModal(id);
    this.ctx.refLayer.clear();
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

    const el = buildModalShell({
      type: node.type,
      color: typeColor(ctx.model, node.type),
      titleHTML: titleHTML(node),
      buttons: TOP_BUTTONS,
      bodyHTML: `<div class="statement">${stmtHtml}</div>${proofHtml ? `<div class="proof-wrap"><div class="proof-label">${escapeHtml(proofLabel)}.</div>${proofHtml}</div>` : ''}`,
      foot: !!proofHtml,
      footLabel: proofLabel,
      collapsed: true, // 默认折叠证明（N1）
    });
    el.dataset.id = node.id;
    const body = el.querySelector('.modal-body');
    this.overlayEl.appendChild(el);

    requestAnimationFrame(() => {
      applyHeightCap(el);
      node.mh = Math.min(el.offsetHeight, maxH());
      this._syncPositions();
    });

    const rec = { el, node, collapsed: true };
    rec.expandProof = () => {
      if (!foot || !rec.collapsed) return;
      rec.collapsed = false;
      body.classList.remove('collapsed');
      foot.innerHTML = `${ICON.chevronUp}<span>折叠${escapeHtml(proofLabel)}</span>`;
      requestAnimationFrame(() => { applyHeightCap(el); node.mh = Math.min(el.offsetHeight, maxH()); this._syncPositions(); });
    };
    rec.scrollToLabel = (labelId) => {
      if (!labelId) return;
      requestAnimationFrame(() => {
        const target = el.querySelector(`[data-label="${cssEscape(labelId)}"]`);
        if (target) target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      });
    };

    el.querySelector('[data-act="to-node"]').addEventListener('click', () => this.closeModal(node.id));
    el.querySelector('[data-act="details"]').addEventListener('click', () => this.ctx.openDetails(node.id));
    el.querySelector('[data-act="open-used"]').addEventListener('click', () => this._openRelated(node, 'used'));
    el.querySelector('[data-act="open-deps"]').addEventListener('click', () => this._openRelated(node, 'deps'));
    el.querySelector('[data-act="hide"]').addEventListener('click', () => this.ctx.hideNode(node.id));

    // proof 折叠条：向下三角=可展开，向上三角=可收起（N1）
    const foot = el.querySelector('.modal-foot');
    if (foot) foot.addEventListener('click', () => {
      rec.collapsed = !rec.collapsed;
      body.classList.toggle('collapsed', rec.collapsed);
      foot.innerHTML = rec.collapsed ? `${ICON.chevronDown}<span>展开${escapeHtml(proofLabel)}</span>` : `${ICON.chevronUp}<span>折叠${escapeHtml(proofLabel)}</span>`;
      requestAnimationFrame(() => { applyHeightCap(el); node.mh = Math.min(el.offsetHeight, maxH()); this._syncPositions(); });
    });

    body.addEventListener('wheel', (ev) => {
      if (body.scrollHeight > body.clientHeight + 1) ev.stopPropagation();
    }, { passive: true });

    this._attachModalDrag(el, node, rec);
    this.ctx.refLayer.bindRefs(el, node, rec);
    el.addEventListener('mouseenter', () => {
      this.ctx.graph.highlightNeighbors(node.id, true);
      this.ctx.refLayer.highlightModal(node.id, true);
    });
    el.addEventListener('mouseleave', () => {
      this.ctx.graph.highlightNeighbors(node.id, false);
      this.ctx.refLayer.highlightModal(node.id, false);
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
    list.forEach((id, i) => {
      const tgt = this.ctx.model.nodeById.get(id);
      const ang = (i / Math.max(1, list.length)) * Math.PI * 2;
      const rad = 380 + Math.floor(i / 6) * 120;
      this.openFromNode(tgt, { x: node.x + Math.cos(ang) * rad, y: node.y + Math.sin(ang) * rad });
    });
    this.ctx.refLayer.refreshRelations();
  }

  _syncPositions() {
    for (const rec of this.open.values()) {
      const n = rec.node;
      const w = rec.el.offsetWidth || CUR_W;
      const h = rec.el.offsetHeight || maxH();
      rec.el.style.transform = `translate(${n.x - w / 2}px, ${n.y - h / 2}px)`;
    }
    this.ctx.refLayer && this.ctx.refLayer.updateRelations();
  }

  _anchorWorld(node, rec, labelId, kind) {
    const w = rec.el.offsetWidth || CUR_W;
    const h = rec.el.offsetHeight || maxH();
    const left = node.x - w / 2;
    const top = node.y - h / 2;
    if (kind === 'refs') return { x: left, y: node.y };
    if (labelId === node.id) return { x: node.x, y: top };
    return { x: left + w, y: node.y };
  }

  // ---- 顶部拖拽 ----
  _attachModalDrag(el, node) {
    const top = el.querySelector('.modal-top');
    let sx, sy, ox, oy;
    const onDown = (ev) => {
      if (ev.target.closest('.m-btn')) return;
      ev.preventDefault();
      ev.stopPropagation();
      sx = ev.clientX; sy = ev.clientY; ox = node.x; oy = node.y;
      el.classList.add('dragging');
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
      node._dragging = false;
      this.ctx.graph.sim.alphaTarget(0);
      node.fx = node.x; node.fy = node.y;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    top.addEventListener('pointerdown', onDown);
  }

  _pulse(nodeId) {
    const rec = this.open.get(nodeId);
    if (!rec) return;
    const base = rec.el.style.transform;
    rec.el.animate([{ transform: base }, { transform: base + ' scale(1.04)' }, { transform: base }], { duration: 300 });
  }
}

function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function proofLabelOf(ctx) { return ctx.model.meta.profileResolved?.id === 'paper' ? '证明' : '详情'; }
function cssEscape(s) { return String(s).replace(/"/g, '\\"'); }
