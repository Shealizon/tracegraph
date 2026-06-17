// =============================================================================
// view/refLayer.js  —  引用交互层
//
//   P3/N6  hover 预览复用 buildModalShell（与正常 modal 同一模板）
//   N5     嵌套 hover：用鼠标 hit-test 维护预览栈，鼠标在 union(预览+anchor) 内不关闭
//   P4     关系箭头：源端定位到被引用方 modal 内"具体 label 行"，终端定位到引用方
//          modal 内"具体 ref span"；随滚动跟踪；元素滚出可视区时投影到边框竖直位置
// =============================================================================
import { buildModalShell, applyHeightCap } from './modal.js';
import { ICON } from '../ui/icons.js';
import { isLeafNode, nodeTag, typeColor } from '../data/schema.js';

const HOVER_CLOSE_DELAY = 180;
const HIT_PAD = 12; // hit-test 容差，便于从 ref 移动到预览

export class RefLayer {
  constructor(ctx, { overlayEl, stageEl }) {
    this.ctx = ctx;
    this.overlayEl = overlayEl;
    this.stageEl = stageEl;
    this.previews = [];
    this.relations = [];
    this.activeNode = null;
    this.raisedRefs = new Set();
    this.nodePreview = null;
    this._mouse = { x: 0, y: 0 };
    this._closeTimer = null;

    window.addEventListener('pointermove', (e) => {
      this._mouse.x = e.clientX;
      this._mouse.y = e.clientY;
      // 实时驱动：鼠标一旦离开临时框命中区域立即收起，不依赖落点是否在其它 modal /
      // 空白面板上（修复悬浮框显示在已有 modal 上方时移不开的问题）。
      this._evalNodePreviewClose();
      this._evalPreviewClose();
    });

    this.relSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.relSvg.id = 'rel-layer';
    stageEl.appendChild(this.relSvg);
    this.raisedSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.raisedSvg.id = 'rel-raised-layer';
    stageEl.appendChild(this.raisedSvg);
  }

  // ---------- node hover 信息卡 ----------
  showNodePreview(anchorEl, node) {
    // 普通节点 hover 显示；展开框仅在远景形态（只剩编号）时也显示具体信息
    if (!node) return;
    if (node.isModal && !(this.ctx.graph && this.ctx.graph.lodFar)) return;
    this._closeNodePreview();
    const shell = document.createElement('div');
    shell.className = `node-tip type-${node.type || ''}`;
    shell.style.setProperty('--node-color', typeColor(this.ctx.model, node.type));
    const num = nodeTag(this.ctx.model, node);
    shell.innerHTML = `<span class="tip-num">${escapeHtml(num)}</span>${escapeHtml(node.title || node.id)}`;
    shell.style.position = 'fixed';
    document.body.appendChild(shell);
    this._placePreview(shell, anchorEl, 12);
    this.nodePreview = { el: shell, anchorEl };
  }

  scheduleNodePreviewClose() {
    // 关闭判定改由实时 pointermove 驱动；这里仅做一次兜底检查。
    setTimeout(() => this._evalNodePreviewClose(), HOVER_CLOSE_DELAY);
  }

  // node-tip 自身 pointer-events:none，鼠标进不去，故只看是否仍悬停在锚点节点上。
  _evalNodePreviewClose() {
    const p = this.nodePreview;
    if (!p) return;
    if (!this._inRect(p.anchorEl)) this._closeNodePreview();
  }

  _inRect(el) {
    if (!el || !document.body.contains(el)) return false;
    const r = el.getBoundingClientRect();
    const { x, y } = this._mouse;
    return x >= r.left - HIT_PAD && x <= r.right + HIT_PAD && y >= r.top - HIT_PAD && y <= r.bottom + HIT_PAD;
  }

  _closeNodePreview() {
    if (this.nodePreview) this.nodePreview.el.remove();
    this.nodePreview = null;
  }

  bindRefs(modalEl, node) {
    modalEl.querySelectorAll('.texref').forEach((span) => {
      const target = span.dataset.target;
      const cmd = span.dataset.cmd;
      const owner = span.dataset.owner || this.ctx.ownerOf(target);
      if (owner === node.id) span.classList.add('internal');
      span.addEventListener('mouseenter', () => this._onRefHover(span, { target, cmd, owner, sourceNode: node }));
      span.addEventListener('mouseleave', () => { this._setRefsRaised(null); this.updateRelations(); this._scheduleClose(); });
      span.addEventListener('click', (ev) => { ev.stopPropagation(); this._onRefClick(span, { target, cmd, owner, sourceNode: node }); });
    });
    const body = modalEl.querySelector('.modal-body');
    if (body) body.addEventListener('scroll', () => {
      if (this.activeNode === node.id) this._raiseVisibleRefsForNode(node.id);
      this.updateRelations();
    }, { passive: true });
    this.refreshRelations();
  }

  highlightModal(nodeId, on) {
    this.activeNode = on ? nodeId : null;
    if (on) this._raiseVisibleRefsForNode(nodeId);
    else this._setRefsRaised(null);
    this.updateRelations();
  }

  setRaiseEnabled(on) {
    this.ctx.refsRaiseEnabled = on;
    if (!on) this._setRefsRaised(null);
    else if (this.activeNode) this._raiseVisibleRefsForNode(this.activeNode);
    this.updateRelations();
  }

  _setRefsRaised(keys) {
    if (!this.ctx.refsRaiseEnabled) keys = null;
    this.raisedRefs = keys ? new Set(keys) : new Set();
    this.raisedSvg.classList.toggle('rel-active', this.raisedRefs.size > 0);
  }

  _raiseVisibleRefsForNode(nodeId) {
    const rec = this.ctx.modals.open.get(nodeId);
    if (!rec) { this._setRefsRaised(null); return; }
    const keys = [...rec.el.querySelectorAll('.texref')]
      .filter((el) => isElementVisible(el))
      .map((el) => relationKeyFromRef(el, rec.node.id, this.ctx))
      .filter(Boolean);
    this._setRefsRaised(keys);
  }

  // ---------- hover 预览 ----------
  _onRefHover(anchorEl, info) {
    if (this._closeTimer) { clearTimeout(this._closeTimer); this._closeTimer = null; }
    const raisedKey = isElementVisible(anchorEl) ? relationKeyFromRef(anchorEl, info.sourceNode?.id, this.ctx) : null;
    this._setRefsRaised(raisedKey ? [raisedKey] : null);
    this.updateRelations();
    // 已有该 anchor 的预览：保持
    if (this.previews.some((p) => p.anchorEl === anchorEl)) return;

    const ownerNode = info.owner ? this.ctx.model.nodeById.get(info.owner) : null;
    const shell = this._buildPreview(info, ownerNode);
    if (!shell) return;

    shell.style.position = 'fixed';
    shell.style.zIndex = String(300 + this.previews.length);
    document.body.appendChild(shell);
    applyHeightCap(shell);

    this._placePreview(shell, anchorEl, 10);

    info.refEl = anchorEl;
    const rec = { el: shell, anchorEl, info, ownerNode };
    this.previews.push(rec);

    shell.addEventListener('mouseenter', () => { if (this._closeTimer) { clearTimeout(this._closeTimer); this._closeTimer = null; } });
    shell.addEventListener('mouseleave', () => this._scheduleClose());

    const pin = shell.querySelector('[data-act="pin"]');
    if (pin) pin.addEventListener('click', (ev) => { ev.stopPropagation(); const i = info; this._closeAllPreviews(); this._pinPreview(i); });

    // 预览内引用：可继续递归 hover / click
    shell.querySelectorAll('.texref').forEach((span) => {
      const t = span.dataset.target, cmd = span.dataset.cmd, owner = span.dataset.owner || this.ctx.ownerOf(t);
      span.addEventListener('mouseenter', () => this._onRefHover(span, { target: t, cmd, owner, sourceNode: ownerNode }));
      span.addEventListener('mouseleave', () => { this._setRefsRaised(null); this.updateRelations(); this._scheduleClose(); });
      span.addEventListener('click', (ev) => { ev.stopPropagation(); this._onRefClick(span, { target: t, cmd, owner, sourceNode: ownerNode }); });
    });
  }

  // 统一延时关闭：到点后用鼠标 hit-test 决定保留哪些层（N5）
  _scheduleClose() {
    if (this._closeTimer) clearTimeout(this._closeTimer);
    this._closeTimer = setTimeout(() => this._closeByHitTest(), HOVER_CLOSE_DELAY);
  }

  // 实时驱动的关闭检查：与 _closeByHitTest 等价，但每次 pointermove 都会执行，
  // 因此鼠标移到任意元素（含其它 modal）上都会即时收起不再命中的预览层。
  _evalPreviewClose() {
    if (!this.previews.length) return;
    this._closeByHitTest();
  }

  // 从栈顶向下：保留鼠标命中的最深预览及其全部祖先，关闭更深的
  _closeByHitTest() {
    // 找到鼠标命中的最深层 index（预览本体或其触发 anchor）
    let keepUpto = -1;
    for (let i = this.previews.length - 1; i >= 0; i--) {
      const p = this.previews[i];
      if (this._inRect(p.el) || this._inRect(p.anchorEl)) { keepUpto = i; break; }
    }
    // 关闭 index > keepUpto 的所有预览；keepUpto=-1 时清空全部。
    if (keepUpto < this.previews.length - 1) {
      const toClose = this.previews.splice(keepUpto + 1);
      toClose.reverse().forEach((p) => p.el.remove());
    }
  }

  _buildPreview(info, ownerNode) {
    const pinBtn = [{ act: 'pin', title: '固定为并排 modal', icon: 'pin' }];
    if (info.cmd === 'cite' || (ownerNode && isLeafNode(this.ctx.model, ownerNode))) {
      const bib = ownerNode || this.ctx.model.nodeById.get(info.target);
      return buildModalShell({ type: bib?.type || 'source', color: bib ? typeColor(this.ctx.model, bib.type) : undefined, preview: true, buttons: pinBtn,
        titleHTML: `${escapeHtml(bib ? nodeTag(this.ctx.model, bib) : info.target)}`,
        bodyHTML: `<p>${escapeHtml(bib?.title || info.target)}</p>` });
    }
    if (!ownerNode) return null;
    const stmt = this.ctx.getRendered ? this.ctx.getRendered(ownerNode.id, 'statement') : this.ctx.render(ownerNode.statementBody);
    if (info.cmd === 'eqref' || this.ctx.kindOf(info.target) === 'equation') {
      const proof = this.ctx.getRendered ? this.ctx.getRendered(ownerNode.id, 'proof') : this.ctx.render(ownerNode.proofBody || '');
      const stmtFormula = extractFormulaHTML(stmt, info.target);
      const proofFormula = extractFormulaHTML(proof, info.target);
      const bodyHTML = stmtFormula ? stmt : (proofFormula || stmt);
      return buildModalShell({ type: ownerNode.type, color: typeColor(this.ctx.model, ownerNode.type), preview: true, buttons: pinBtn,
        titleHTML: `<span class="m-num">${escapeHtml(nodeTag(this.ctx.model, ownerNode))}</span> · ${escapeHtml(ownerNode.title || '')}`, bodyHTML });
    }
    return buildModalShell({ type: ownerNode.type, color: typeColor(this.ctx.model, ownerNode.type), preview: true, buttons: pinBtn,
      titleHTML: `<span class="m-num">${escapeHtml(nodeTag(this.ctx.model, ownerNode))}</span> · ${escapeHtml(ownerNode.title || '')}`,
      bodyHTML: stmt });
  }

  _pinPreview(info) {
    if (!info.owner) return;
    const ownerNode = this.ctx.model.nodeById.get(info.owner);
    if (!ownerNode || isLeafNode(this.ctx.model, ownerNode)) { ownerNode && this.ctx.openDetails(ownerNode.id); return; }
    if (info.sourceNode && info.owner === info.sourceNode.id) return;
    const inProof = isLabelInProof(this.ctx, ownerNode, info.target);
    this.ctx.modals.openBeside(ownerNode, info.sourceNode || ownerNode, 'right', { expandProof: inProof, scrollLabel: info.target });
    this.refreshRelations();
  }

  // ---------- click 并排 ----------
  _onRefClick(anchorEl, info) {
    this._closeAllPreviews();
    if (!info.owner) return;
    const ownerNode = this.ctx.model.nodeById.get(info.owner);
    if (!ownerNode) return;
    if (isLeafNode(this.ctx.model, ownerNode)) { this.ctx.openDetails(ownerNode.id); return; }
    if (info.sourceNode && info.owner === info.sourceNode.id) {
      const inProof = isLabelInProof(this.ctx, ownerNode, info.target);
      this.ctx.modals.openFromNode(ownerNode, { expandProof: inProof, scrollLabel: info.target });
      return;
    }

    const inProof = isLabelInProof(this.ctx, ownerNode, info.target);
    this.ctx.modals.openBeside(ownerNode, info.sourceNode || ownerNode, 'right', { expandProof: inProof, scrollLabel: info.target });
    this.refreshRelations();
  }

  _addRelation(fromNode, fromLabel, toNode, refEl) {
    // 去重
    if (this.relations.some((r) => r.fromNode === fromNode && r.fromLabel === fromLabel && r.toNode === toNode)) {
      this.refreshRelations();
      return;
    }
    this.relations.push({ fromNode, fromLabel, toNode, refEl });
    this.refreshRelations();
  }

  _closeAllPreviews() {
    if (this._closeTimer) { clearTimeout(this._closeTimer); this._closeTimer = null; }
    this.previews.forEach((p) => p.el.remove());
    this.previews = [];
    this._setRefsRaised(null);
  }

  // ---------- 关系箭头（P4） ----------
  refreshRelations() {
    this.relations = this._collectVisibleRelations();
    this.updateRelations();
  }

  _collectVisibleRelations() {
    const out = [];
    const seen = new Map();
    const add = (r) => {
      const key = `${r.fromNode}|${r.fromLabel}|${r.toNode}`;
      if (seen.has(key)) {
        const i = seen.get(key);
        if (!out[i].refEl && r.refEl) out[i] = r;
        return;
      }
      seen.set(key, out.length);
      out.push(r);
    };

    const present = (id) => {
      const n = this.ctx.model.nodeById.get(id);
      // 对端是 modal 始终算存在；否则需通过过滤/隐藏/视图可见性检查
      return !!n && (n.isModal || this.ctx.graph.isNodePresent(n));
    };

    for (const rec of this.ctx.modals.open.values()) {
      const modalEl = rec.el;
      const node = rec.node;

      // 只要 modal 中出现某个 ref，就把 ref 的精确 DOM 位置作为终点。
      modalEl.querySelectorAll('.texref').forEach((refEl, i) => {
        const target = refEl.dataset.target;
        const owner = refEl.dataset.owner || this.ctx.ownerOf(target);
        if (!owner || owner === node.id) return;
        if (!present(owner)) return; // 被引用方被过滤/隐藏：不画到隐形锚点
        add({ fromNode: owner, fromLabel: target, toNode: node.id, refEl, refKey: `${node.id}:${i}`, mode: 'outgoing' });
      });

      // 只要 modal 中出现某个 label，就把使用该 label 的节点也连出来。
      for (const l of this.ctx.graph.links) {
        if (l.from !== node.id) continue;
        if (!present(l.to)) continue; // 引用方被过滤/隐藏：跳过
        add({ fromNode: node.id, fromLabel: l.fromLabel, toNode: l.to, refEl: null, refKey: `${l.to}:${l.fromLabel}`, mode: 'incoming' });
      }
    }
    return out;
  }

  updateRelations() {
    this.relSvg.innerHTML = '';
    this.raisedSvg.innerHTML = '';
    const rect = this.stageEl.getBoundingClientRect();
    for (const svg of [this.relSvg, this.raisedSvg]) {
      svg.setAttribute('width', rect.width);
      svg.setAttribute('height', rect.height);
    }

    for (const r of this.relations) {
      const p1 = this._labelPoint(r.fromNode, r.fromLabel, rect);
      const p2 = r.refEl && document.body.contains(r.refEl)
        ? this._elemPointClamped(r.refEl, this.ctx.modals.open.get(r.toNode)?.el, rect, 'target')
        : this._refsPoint(r.toNode, rect);
      if (!p1 || !p2) continue;
      const active = this.activeNode && (r.fromNode === this.activeNode || r.toNode === this.activeNode);
      const dimmed = this.activeNode && !active;
      const raised = this.ctx.refsRaiseEnabled && this.raisedRefs.has(relationKey(r.fromNode, r.fromLabel, r.toNode));
      const svg = raised ? this.raisedSvg : this.relSvg;

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
      const dx = p2.x - p1.x, dy = p2.y - p1.y;
      const n = Math.hypot(dx, dy) || 1;
      const cx = mx - (dy / n) * 22, cy = my + (dx / n) * 22;
      path.setAttribute('d', `M${p1.x},${p1.y} Q${cx},${cy} ${p2.x},${p2.y}`);
      path.setAttribute('class', `rel-path${active || raised ? ' hi' : ''}${raised ? ' raised' : ''}${dimmed ? ' dimmed' : ''}`);
      svg.appendChild(path);

      const c1 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c1.setAttribute('class', `rel-dot rel-dot-from${active || raised ? ' hi' : ''}${raised ? ' raised' : ''}${dimmed ? ' dimmed' : ''}`);
      c1.setAttribute('cx', p1.x); c1.setAttribute('cy', p1.y); c1.setAttribute('r', '3.5');
      svg.appendChild(c1);

      const ang = Math.atan2(p2.y - cy, p2.x - cx);
      const s = 8;
      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      poly.setAttribute('class', `rel-arrow${active || raised ? ' hi' : ''}${raised ? ' raised' : ''}${dimmed ? ' dimmed' : ''}`);
      poly.setAttribute('points', `${p2.x},${p2.y} ${p2.x - Math.cos(ang - 0.4) * s},${p2.y - Math.sin(ang - 0.4) * s} ${p2.x - Math.cos(ang + 0.4) * s},${p2.y - Math.sin(ang + 0.4) * s}`);
      svg.appendChild(poly);
      const c2 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c2.setAttribute('class', `rel-dot rel-dot-to${active || raised ? ' hi' : ''}${raised ? ' raised' : ''}${dimmed ? ' dimmed' : ''}`);
      c2.setAttribute('cx', p2.x); c2.setAttribute('cy', p2.y); c2.setAttribute('r', '3.5');
      svg.appendChild(c2);
    }
  }

  _labelPoint(nodeId, labelId, stageRect) {
    const rec = this.ctx.modals.open.get(nodeId);
    // 远景 LOD-modal：锚点落在边界（顶部），与 node 一致
    if (rec && this.ctx.graph.lodFar) return this._modalEdgePoint(rec.el, stageRect, 'top');
    if (rec) return this._anchorPointInModal(rec.el, labelId, nodeId, stageRect, 'source');
    const node = this.ctx.model.nodeById.get(nodeId);
    if (!node) return null;
    const a = this.ctx.graph.anchorPos(node, labelId);
    const p = this.ctx.graph.worldToScreen(a.x, a.y);
    return { x: p.x, y: p.y };
  }

  _refsPoint(nodeId, stageRect) {
    const rec = this.ctx.modals.open.get(nodeId);
    if (rec && this.ctx.graph.lodFar) return this._modalEdgePoint(rec.el, stageRect, 'bottom');
    if (rec) return this._elemPointClamped(rec.el.querySelector('.modal-top'), rec.el, stageRect, 'target');
    const node = this.ctx.model.nodeById.get(nodeId);
    if (!node) return null;
    const a = this.ctx.graph.refsPos(node);
    const p = this.ctx.graph.worldToScreen(a.x, a.y);
    return { x: p.x, y: p.y };
  }

  // 远景：取展开框边框中点（顶/底）作为锚点
  _modalEdgePoint(modalEl, stageRect, edge) {
    const r = modalEl.getBoundingClientRect();
    const x = r.left + r.width / 2 - stageRect.left;
    const y = (edge === 'top' ? r.top : r.bottom) - stageRect.top;
    return { x, y };
  }

  _placePreview(shell, anchorEl, gap) {
    const r = anchorEl.getBoundingClientRect();
    const ew = shell.offsetWidth, eh = shell.offsetHeight;
    let x = r.right + gap;
    let y = Math.max(8, Math.min(r.top, window.innerHeight - eh - 8));
    if (x + ew > window.innerWidth - 8) x = r.left - ew - gap;
    if (x < 8) x = Math.max(8, Math.min(r.left, window.innerWidth - ew - 8));
    shell.style.left = `${x}px`;
    shell.style.top = `${y}px`;
  }

  // 在 modal 内定位某 label 的锚点（屏幕坐标，含越界投影到边框）
  _anchorPointInModal(modalEl, labelId, nodeId, stageRect, role) {
    let target = null;
    if (labelId === nodeId) {
      target = modalEl.querySelector('.m-num') || modalEl.querySelector('.modal-top');
    } else {
      target = modalEl.querySelector(`[data-label="${cssEscape(labelId)}"]`);
    }
    return this._elemPointClamped(target, modalEl, stageRect, role, labelId === nodeId ? 'top-center' : 'right');
  }

  // 元素中心 -> 屏幕坐标（相对 stage）；若元素被 modal-body 滚动裁出可视区，
  // 投影到 modal 边框对应竖直位置（P4）
  _elemPointClamped(el, modalEl, stageRect, role, fallback = 'auto') {
    if (!modalEl) return null;
    const mr = modalEl.getBoundingClientRect();
    const body = modalEl.querySelector('.modal-body');
    const br = body ? body.getBoundingClientRect() : mr;

    if (!el) {
      const topHalf = !body || body.scrollTop < (body.scrollHeight - body.clientHeight) / 2;
      const y = topHalf ? br.top : br.bottom;
      const x = role === 'source' ? mr.right : mr.left;
      return { x: x - stageRect.left, y: y - stageRect.top };
    }

    const er = el.getBoundingClientRect();

    let cy = er.top + er.height / 2;
    let visible = true;
    // 纵向裁剪到 body 可视范围
    if (cy < br.top) { cy = br.top; visible = false; }
    else if (cy > br.bottom) { cy = br.bottom; visible = false; }

    let cx;
    if (role === 'source') cx = mr.right;
    else if (visible) cx = Math.max(mr.left, Math.min(mr.right, er.left + er.width / 2));
    else cx = mr.left;

    if (fallback === 'top-center') { cx = mr.left + mr.width / 2; cy = mr.top; }
    if (fallback === 'right') cx = mr.right;

    return { x: cx - stageRect.left, y: cy - stageRect.top };
  }

  clear() {
    this._closeAllPreviews();
    this.relations = [];
    this.activeNode = null;
    this._setRefsRaised(null);
    this.updateRelations();
  }

  _flash(el) {
    el.animate([{ background: 'rgba(124,156,255,.5)' }, { background: 'rgba(124,156,255,.12)' }], { duration: 600 });
  }
}

function cssEscape(s) { return String(s).replace(/"/g, '\\"'); }
function extractFormulaHTML(html, labelId) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const el = tmp.querySelector(`[data-label="${cssEscape(labelId)}"]`);
  return el ? el.outerHTML : '';
}
function isLabelInProof(ctx, node, labelId) {
  if (!node?.proofBody) return false;
  const proof = ctx.getRendered ? ctx.getRendered(node.id, 'proof') : ctx.render(node.proofBody || '');
  return !!extractFormulaHTML(proof, labelId);
}
function isElementVisible(el) {
  if (!el || !document.body.contains(el)) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return false;
  const body = el.closest('.modal-body');
  if (!body) return true;
  const b = body.getBoundingClientRect();
  return r.bottom >= b.top && r.top <= b.bottom;
}
function relationKey(fromNode, fromLabel, toNode) { return `${fromNode}|${fromLabel}|${toNode}`; }
function relationKeyFromRef(el, sourceNodeId, ctx) {
  if (!el || !sourceNodeId) return null;
  const target = el.dataset.target;
  const owner = el.dataset.owner || ctx.ownerOf(target);
  if (!owner || owner === sourceNodeId) return null;
  return relationKey(owner, target, sourceNodeId);
}
function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
