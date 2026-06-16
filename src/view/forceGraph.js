// =============================================================================
// view/forceGraph.js  —  Phase 3 力导向图（+ Phase 5 modal 物理）
//
// 混合渲染：
//   * SVG (#edges-layer)   —— 边、箭头、label/refs 锚点
//   * HTML (#nodes-layer)  —— 节点 div（圆 / modal 方形都在这层）
//   * 共享 pan/zoom transform（d3-zoom），同步作用于 SVG <g> 与 HTML 层
//
// 物理：
//   d3-forceSimulation: link + charge + center + collide(圆)
//   + 自定义 forceRect: modal 作为高质量 AABB，推开圆节点、自身难移动
//
// 边方向：A.fromLabel(锚点) -> B.refs(锚点)。show-modals-only 下，
//   两端必须都处于 modal 状态，边才显示。
// =============================================================================

import * as d3 from 'd3';
import { isLeafNode, nodeTag, typeColor } from '../data/schema.js';

export class ForceGraph {
  constructor(model, { stageEl, svgEl, nodesEl, overlayEl, onNodeActivate, onAnchorEnter, onAnchorLeave }) {
    this.model = model;
    this.stageEl = stageEl;
    this.svg = d3.select(svgEl);
    this.nodesEl = nodesEl;
    this.overlayEl = overlayEl;
    this.onNodeActivate = onNodeActivate || (() => {});
    this.onAnchorEnter = onAnchorEnter || (() => {});
    this.onAnchorLeave = onAnchorLeave || (() => {});

    this.nodes = model.nodes;
    this.links = model.edges.map((e) => ({ ...e, source: e.from, target: e.to }));
    this.transform = d3.zoomIdentity;
    this.mode = 'show-all'; // show-all | show-modals-only

    this._initSvg();
    this._initNodes();
    this._initSim();
    this._initZoom();
    window.addEventListener('resize', () => this._resize());
    this._resize();
  }

  // ---- SVG 结构 ----
  _initSvg() {
    const root = this.svg.append('g').attr('class', 'zoom-g');
    this.gEdges = root.append('g').attr('class', 'edges');
    this.gArrows = root.append('g').attr('class', 'arrows');
    this.gAnchors = root.append('g').attr('class', 'anchors');
    this.zoomG = root;

    this.edgeSel = this.gEdges.selectAll('path');
    this.arrowSel = this.gArrows.selectAll('polygon');
    this.edgeDotSel = this.gAnchors.selectAll('circle');
  }

  // ---- HTML 节点 ----
  _initNodes() {
    const self = this;
    this.nodeEls = new Map();
    for (const n of this.nodes) {
      const el = document.createElement('div');
      el.className = `node type-${cssSafe(n.type)}`;
      el.style.setProperty('--node-color', typeColor(this.model, n.type));
      const d = n.radius * 2;
      el.style.width = `${d}px`;
      el.style.height = `${d}px`;
      el.dataset.id = n.id;
      el.innerHTML = nodeInnerHTML(this.model, n);
      this._fitNodeText(el, n);
      el.addEventListener('click', (ev) => {
        if (el._dragged) { el._dragged = false; return; }
        ev.stopPropagation();
        self.onNodeActivate(n, el);
      });
      this._attachDrag(el, n);
      this.nodesEl.appendChild(el);
      this.nodeEls.set(n.id, el);
      n.x = (Math.random() - 0.5) * 600;
      n.y = (Math.random() - 0.5) * 600;
    }
  }

  // 按半径自适应节点内文字大小：编号上、名称下；圆太小则隐藏名称
  _fitNodeText(el, n) {
    const r = n.radius;
    const mainEl = el.querySelector('.node-main');
    const typeEl = el.querySelector('.node-type');
    const numEl = el.querySelector('.node-num');
    const titleEl = el.querySelector('.node-title');
    if (isLeafNode(this.model, n)) {
      if (numEl) numEl.style.fontSize = `${Math.max(9, r * 0.5).toFixed(1)}px`;
      if (typeEl) typeEl.style.fontSize = `${Math.max(7, r * 0.32).toFixed(1)}px`;
      layoutCircleRect(mainEl, r, 0.26, 0.72, 0.86);
      return;
    }
    // 上下两个矩形完全落在圆内；字体只随半径变化，超出省略。
    const numSize = clamp(r * 0.31, 12, 22);
    const typeSize = clamp(r * 0.16, 8, 11);
    const titleSize = clamp(r * 0.165, 9.5, 12.5);
    if (typeEl) typeEl.style.fontSize = `${typeSize.toFixed(1)}px`;
    if (numEl) numEl.style.fontSize = `${numSize.toFixed(1)}px`;
    layoutCircleRect(mainEl, r, 0.18, 0.50, 0.9);
    if (titleEl) {
      titleEl.style.fontSize = `${titleSize.toFixed(1)}px`;
      if (r < 28) {
        titleEl.classList.add('hide');
      } else {
        titleEl.classList.remove('hide');
        layoutCircleRect(titleEl, r, 0.55, 0.84, 0.92);
        const lineH = titleSize * 1.18;
        const lines = Math.max(1, Math.floor((r * 2 * (0.84 - 0.55)) / lineH));
        titleEl.style.maxHeight = `${(lineH * lines).toFixed(1)}px`;
        titleEl.style.webkitLineClamp = String(lines);
      }
    }
  }

  // ---- 模拟 ----
  _initSim() {
    // 可调力参数（默认值）
    this.forceParams = { center: 0.17, charge: 540, link: 0.18 };

    this.linkForce = d3
      .forceLink(this.links)
      .id((d) => d.id)
      .distance((l) => 140 + (this.model.nodeById.get(l.source.id || l.source)?.radius || 30))
      .strength(this.forceParams.link);

    this.chargeForce = d3.forceManyBody().strength(() => -this.forceParams.charge);
    this.centerForce = d3.forceCenter(0, 0).strength(this.forceParams.center);

    this.sim = d3
      .forceSimulation(this.nodes)
      .force('link', this.linkForce)
      .force('charge', this.chargeForce)
      .force('center', this.centerForce)
      .force('collide', d3.forceCollide().radius((d) => (d.isModal ? 0 : d.radius + 22)).strength(0.95))
      .force('rect', this._forceRect())
      .velocityDecay(0.32)
      .alphaDecay(0.025)
      .on('tick', () => this._tick());
  }

  // 调节力参数（N4）：name ∈ center|charge|link
  setForce(name, value) {
    this.forceParams[name] = value;
    if (name === 'center') this.centerForce.strength(value);
    else if (name === 'charge') this.chargeForce.strength(() => -value);
    else if (name === 'link') this.linkForce.strength(value);
    this.reheat(0.5);
  }
  getForce(name) { return this.forceParams[name]; }

  // 自定义矩形力：modal 以真实 AABB 体积排开
  //   * modal ↔ 圆节点：把圆推开（modal 质量大，反作用小）
  //   * modal ↔ modal：双向 AABB 分离，避免堆叠
  _forceRect() {
    const nodes = this.nodes;
    const PAD = 20;
    const MPAD = 44; // modal 间额外间距
    const force = (alpha) => {
      const modals = nodes.filter((n) => n.isModal && n.mw && n.mh);

      // modal 位移直接写 fx/fy（modal 恒为 pinned），保证稳定且能被排开
      const nudge = (m, ddx, ddy) => {
        if (m._dragging) return; // 拖拽中不被力推走
        if (m.fx == null) m.fx = m.x;
        if (m.fy == null) m.fy = m.y;
        m.fx += ddx; m.fy += ddy;
      };

      // modal ↔ 圆：把圆推开，modal 仅轻微让位
      for (const m of modals) {
        // pinned modal 不受 d3 center force 影响，这里给同等质量的中心牵引。
        if (!m._dragging) nudge(m, -m.x * this.forceParams.center * alpha * 1.8, -m.y * this.forceParams.center * alpha * 1.8);
        const hw = m.mw / 2 + PAD;
        const hh = m.mh / 2 + PAD;
        for (const o of nodes) {
          if (o === m || o.isModal) continue;
          const dx = o.x - m.x;
          const dy = o.y - m.y;
          const ox = hw + o.radius - Math.abs(dx);
          const oy = hh + o.radius - Math.abs(dy);
          if (ox > 0 && oy > 0) {
            if (ox < oy) {
              const push = (dx >= 0 ? 1 : -1) * ox;
              o.vx += push * 0.20;
              nudge(m, -push * 0.20, 0);
            } else {
              const push = (dy >= 0 ? 1 : -1) * oy;
              o.vy += push * 0.20;
              nudge(m, 0, -push * 0.20);
            }
          }
        }
      }

      // modal ↔ modal：双向 AABB 分离（直接调整 fx/fy）
      for (let i = 0; i < modals.length; i++) {
        for (let j = i + 1; j < modals.length; j++) {
          const a = modals[i], b = modals[j];
          const minX = (a.mw + b.mw) / 2 + MPAD;
          const minY = (a.mh + b.mh) / 2 + MPAD;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const ox = minX - Math.abs(dx);
          const oy = minY - Math.abs(dy);
          if (ox > 0 && oy > 0) {
            const s = 0.18;
            if (ox < oy) {
              const push = (dx >= 0 ? 1 : -1) * ox * s;
              nudge(b, push, 0); nudge(a, -push, 0);
            } else {
              const push = (dy >= 0 ? 1 : -1) * oy * s;
              nudge(b, 0, push); nudge(a, 0, -push);
            }
          }
        }
      }
    };
    force.initialize = () => {};
    return force;
  }

  // ---- zoom ----
  _initZoom() {
    this.zoom = d3
      .zoom()
      .scaleExtent([0.18, 2.6])
      // 在节点圆 / modal / 详情页上不触发平移缩放（让 modal 内滚动正常 —— P11）
      .filter((ev) => {
        const t = ev.target;
        if (this.zoomLocked && ev.type === 'wheel') return false;
        if (t.closest && (t.closest('.node') || t.closest('.modal') || t.closest('.details-page') || t.closest('.zoom-control') || t.closest('.sidebar-rail'))) return false;
        return true;
      })
      .on('start', () => this.stageEl.classList.add('panning'))
      .on('zoom', (ev) => {
        this.transform = ev.transform;
        this._applyTransform();
      })
      .on('end', () => this.stageEl.classList.remove('panning'));
    d3.select(this.stageEl).call(this.zoom).on('dblclick.zoom', null);
  }

  _applyTransform() {
    const t = this.transform;
    this.zoomG.attr('transform', t);
    const css = `translate(${t.x}px, ${t.y}px) scale(${t.k})`;
    this.nodesEl.style.transform = css;
    this.overlayEl.style.transform = css;
    this._notifyOverlay && this._notifyOverlay();
    this._notifyZoom && this._notifyZoom(t.k);
  }

  setOverlaySync(fn) { this._notifyOverlay = fn; }
  setZoomSync(fn) { this._notifyZoom = fn; fn && fn(this.transform.k); }
  setZoomLocked(on) { this.zoomLocked = !!on; }
  getZoomScale() { return this.transform.k; }
  setZoomScale(k) {
    const next = clamp(k, 0.18, 2.6);
    const cx = this.W / 2;
    const cy = this.H / 2;
    const w = this.screenToWorld(cx, cy);
    const t = d3.zoomIdentity.translate(cx - w.x * next, cy - w.y * next).scale(next);
    d3.select(this.stageEl).transition().duration(120).call(this.zoom.transform, t);
  }

  _resize() {
    const r = this.stageEl.getBoundingClientRect();
    this.W = r.width;
    this.H = r.height;
    // SVG 使用与 HTML 层一致的左上原点坐标系；缩放/平移统一交给 zoom transform。
    this.svg.attr('viewBox', `0 0 ${this.W} ${this.H}`).attr('width', this.W).attr('height', this.H);
    // 初次：把世界原点 (0,0) 放到舞台中心
    if (!this._centered) {
      this.transform = d3.zoomIdentity.translate(this.W / 2, this.H / 2).scale(0.82);
      d3.select(this.stageEl).call(this.zoom.transform, this.transform);
      this._centered = true;
    } else {
      this._applyTransform();
    }
  }

  // ---- 拖拽 ----
  _attachDrag(el, n) {
    let sx, sy, ox, oy, moved;
    const onDown = (ev) => {
      ev.stopPropagation();
      sx = ev.clientX; sy = ev.clientY; ox = n.x; oy = n.y; moved = false;
      n.fx = n.x; n.fy = n.y;
      this.sim.alphaTarget(0.18).restart();
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };
    const onMove = (ev) => {
      const k = this.transform.k;
      const dx = (ev.clientX - sx) / k;
      const dy = (ev.clientY - sy) / k;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      n.fx = ox + dx; n.fy = oy + dy;
    };
    const onUp = () => {
      this.sim.alphaTarget(0);
      if (!n.isModal && !n.pinned) { n.fx = null; n.fy = null; }
      el._dragged = moved;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    el.addEventListener('pointerdown', onDown);
  }

  // 节点圆是否应可见（综合：modal态 / 类型过滤 / 手动隐藏 / 仅显示modals模式）
  _nodeVisible(n) {
    if (n.isModal) return false; // 展开为 modal 时圆隐藏
    if (n._userHidden) return false; // P8 手动隐藏
    if (n._hidden) return false; // 类型过滤
    if (this.mode === 'show-modals-only') return false; // 仅显示 modals：其它圆全隐藏
    return true;
  }

  // 关系收集用：节点是否在图中“存在”（modal 仍算存在，圆只是变形态）
  isNodePresent(n) {
    if (!n) return false;
    if (n._userHidden) return false;       // 手动隐藏
    if (n._hidden) return false;           // 类型过滤
    if (this.mode === 'show-modals-only' && !n.isModal) return false;
    return true;
  }

  // 统一刷新节点可见性（用 class，避免被 _tick 的 display 覆盖）
  updateVisibility() {
    for (const n of this.nodes) {
      const el = this.nodeEls.get(n.id);
      if (el) el.classList.toggle('node-hidden', !this._nodeVisible(n));
    }
    this._renderEdges();
    this.ctx && this.ctx.refLayer && this.ctx.refLayer.refreshRelations();
  }

  // ---- 每帧更新 ----
  _tick() {
    for (const n of this.nodes) {
      const el = this.nodeEls.get(n.id);
      if (!el) continue;
      el.classList.toggle('node-hidden', !this._nodeVisible(n));
      if (n.isModal) continue;
      const r = n.radius;
      el.style.transform = `translate(${n.x - r}px, ${n.y - r}px)`;
    }
    this._renderEdges();
    this._notifyOverlay && this._notifyOverlay();
  }

  // 计算某节点上某 label 锚点的世界坐标
  anchorPos(node, labelId) {
    if (node.isModal) return this._modalAnchor(node, labelId, 'label');
    const lab = node.labels.find((l) => l.id === labelId) || node.labels[0];
    if (!lab || lab.id === node.id || lab.kind !== 'equation') return { x: node.x, y: node.y - node.radius };
    const equations = node.labels.filter((l) => l.kind === 'equation');
    const i = Math.max(0, equations.findIndex((l) => l.id === lab.id));
    const side = i % 2 === 0 ? -1 : 1;
    const sideIndex = Math.floor(i / 2);
    const countSide = Math.ceil(equations.length / 2);
    const span = node.radius * 1.25;
    const y = node.y - span / 2 + (countSide <= 1 ? span / 2 : (sideIndex / (countSide - 1)) * span);
    return { x: node.x + side * node.radius, y };
  }
  refsPos(node) {
    if (node.isModal) return this._modalAnchor(node, null, 'refs');
    return { x: node.x, y: node.y + node.radius };
  }
  _modalAnchor(node, labelId, kind) {
    // modal 是 DOM 元素；锚点由 modal 模块登记的相对偏移给出（默认取边缘中点）
    if (node._anchorResolver) {
      const p = node._anchorResolver(labelId, kind);
      if (p) return p;
    }
    const hw = (node.mw || 100) / 2;
    const hh = (node.mh || 100) / 2;
    return kind === 'refs' ? { x: node.x - hw, y: node.y } : { x: node.x + hw, y: node.y };
  }

  // ---- 边渲染 ----
  _renderEdges() {
    const self = this;
    const visible = this.links.filter((l) => this._edgeVisible(l));
    const paths = this.gEdges.selectAll('path').data(visible, (d) => `${d.from}|${d.fromLabel}|${d.to}`);
    paths.exit().remove();
    const ent = paths
      .enter()
      .append('path')
      .attr('class', 'edge-path');
    this.edgeSel = ent.merge(paths);

    const arr = this.gArrows.selectAll('polygon').data(visible, (d) => `${d.from}|${d.fromLabel}|${d.to}`);
    arr.exit().remove();
    const arrEnt = arr.enter().append('polygon').attr('class', 'arrowhead');
    this.arrowSel = arrEnt.merge(arr);

    const dotsData = visible.flatMap((d) => ([{ ...d, end: 'from' }, { ...d, end: 'to' }]));
    const dots = this.gAnchors.selectAll('circle').data(dotsData, (d) => `${d.from}|${d.fromLabel}|${d.to}|${d.end}`);
    dots.exit().remove();
    const dotEnt = dots.enter().append('circle').attr('class', (d) => `edge-dot edge-dot-${d.end}`).attr('r', 3.2);
    this.edgeDotSel = dotEnt.merge(dots);

    this.edgeSel.attr('d', (l) => self._edgePath(l)).classed('hi', (l) => !!l._hi).classed('dimmed', (l) => !!l._dim);
    this.arrowSel.attr('points', (l) => self._arrowPoints(l)).classed('hi', (l) => !!l._hi);
    this.edgeDotSel
      .attr('cx', (l) => self._edgeDotPos(l).x)
      .attr('cy', (l) => self._edgeDotPos(l).y)
      .classed('hi', (l) => !!l._hi)
      .classed('dimmed', (l) => !!l._dim);
  }

  _edgeVisible(l) {
    const a = this.model.nodeById.get(l.from);
    const b = this.model.nodeById.get(l.to);
    if (!a || !b) return false;
    if (this.mode === 'show-modals-only') return a.isModal && b.isModal;
    if (a.isModal || b.isModal) return false;
    if (a._hidden || b._hidden) return false;
    if (a._userHidden || b._userHidden) return false;
    return true;
  }

  _edgePath(l) {
    const a = this.model.nodeById.get(l.from);
    const b = this.model.nodeById.get(l.to);
    const p1 = this.anchorPos(a, l.fromLabel);
    const p2 = this.refsPos(b);
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const norm = Math.hypot(dx, dy) || 1;
    // 轻微弯曲
    const curve = Math.min(40, norm * 0.18);
    const cx = mx - (dy / norm) * curve;
    const cy = my + (dx / norm) * curve;
    return `M${p1.x},${p1.y} Q${cx},${cy} ${p2.x},${p2.y}`;
  }

  _arrowPoints(l) {
    const a = this.model.nodeById.get(l.from);
    const b = this.model.nodeById.get(l.to);
    const p1 = this.anchorPos(a, l.fromLabel);
    const p2 = this.refsPos(b);
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const ang = Math.atan2(dy, dx);
    const size = 7;
    const tipX = p2.x - Math.cos(ang) * 3;
    const tipY = p2.y - Math.sin(ang) * 3;
    const a1 = ang + Math.PI - 0.4;
    const a2 = ang + Math.PI + 0.4;
    return `${tipX},${tipY} ${tipX + Math.cos(a1) * size},${tipY + Math.sin(a1) * size} ${tipX + Math.cos(a2) * size},${tipY + Math.sin(a2) * size}`;
  }

  _edgeDotPos(l) {
    const a = this.model.nodeById.get(l.from);
    const b = this.model.nodeById.get(l.to);
    return l.end === 'from' ? this.anchorPos(a, l.fromLabel) : this.refsPos(b);
  }

  // ---- 公共 API ----
  setMode(mode) {
    this.mode = mode;
    this.updateVisibility();
    this._tick();
  }

  reheat(a = 0.5) { this.sim.alpha(a).restart(); }

  worldToScreen(x, y) {
    return { x: x * this.transform.k + this.transform.x, y: y * this.transform.k + this.transform.y };
  }
  screenToWorld(sx, sy) {
    return { x: (sx - this.transform.x) / this.transform.k, y: (sy - this.transform.y) / this.transform.k };
  }

  highlightNeighbors(nodeId, on) {
    if (!on) {
      this.nodeEls.forEach((el) => el.classList.remove('dimmed'));
      this.links.forEach((l) => { l._hi = false; l._dim = false; });
      this._renderEdges();
      return;
    }
    const keep = new Set([nodeId]);
    for (const m of this.model.deps.get(nodeId) || []) keep.add(m);
    for (const m of this.model.usedBy.get(nodeId) || []) keep.add(m);
    this.nodeEls.forEach((el, id) => el.classList.toggle('dimmed', !keep.has(id)));
    this.links.forEach((l) => {
      l._hi = l.from === nodeId || l.to === nodeId;
      l._dim = !(keep.has(l.from) && keep.has(l.to));
    });
    this._renderEdges();
  }

  highlightCone(coneSet, rootId) {
    this.nodeEls.forEach((el, id) => {
      const inCone = coneSet.has(id) || id === rootId;
      el.classList.toggle('dimmed', !inCone);
      el.classList.toggle('cone-hi', coneSet.has(id));
    });
    this.links.forEach((l) => {
      const inside = (coneSet.has(l.from) || l.from === rootId) && (coneSet.has(l.to) || l.to === rootId);
      l._dim = !inside;
      l._hi = inside;
    });
    this._renderEdges();
  }

  clearHighlight() {
    this.nodeEls.forEach((el) => el.classList.remove('dimmed', 'cone-hi', 'search-hit'));
    this.links.forEach((l) => { l._hi = false; l._dim = false; });
    this._renderEdges();
  }

  focusNode(nodeId, scale = 1.0) {
    const n = this.model.nodeById.get(nodeId);
    if (!n) return;
    const t = d3.zoomIdentity.translate(this.W / 2 - n.x * scale, this.H / 2 - n.y * scale).scale(scale);
    d3.select(this.stageEl).transition().duration(550).call(this.zoom.transform, t);
  }
}

function nodeInnerHTML(model, n) {
  if (isLeafNode(model, n)) {
    return `<div class="node-main"><div class="node-type">${escapeHtml(n.typeLabel || n.type || 'ref')}</div><div class="node-num">${escapeHtml(nodeTag(model, n))}</div></div>`;
  }
  return `<div class="node-main"><div class="node-type">${n.typeLabel}</div><div class="node-num">${n.number}</div></div><div class="node-title">${escapeHtml(n.title || '')}</div>`;
}
function cssSafe(s) { return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '-'); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function layoutCircleRect(el, r, topFrac, bottomFrac, shrink = 1) {
  if (!el) return;
  const d = r * 2;
  const top = d * topFrac;
  const bottom = d * bottomFrac;
  const cy1 = Math.abs(top - r);
  const cy2 = Math.abs(bottom - r);
  const half = Math.sqrt(Math.max(0, r * r - Math.max(cy1, cy2) ** 2)) * shrink;
  el.style.left = `${(r - half).toFixed(1)}px`;
  el.style.top = `${top.toFixed(1)}px`;
  el.style.width = `${(half * 2).toFixed(1)}px`;
  el.style.height = `${(bottom - top).toFixed(1)}px`;
}
function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
