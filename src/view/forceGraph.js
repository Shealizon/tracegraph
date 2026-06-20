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

// 缩放范围与空间边界：最小 10%；世界边界 = 15% 缩放时铺满当前视口的范围（隐藏的硬墙）
const MIN_K = 0.10;
const MAX_K = 2.6;
const BOUND_ZOOM = 0.15;

export class ForceGraph {
  constructor(model, { stageEl, svgEl, nodesEl, overlayEl, onNodeActivate, onAnchorEnter, onAnchorLeave, storageKey, initialTransform }) {
    this.model = model;
    this.stageEl = stageEl;
    this.svg = d3.select(svgEl);
    this.nodesEl = nodesEl;
    this.overlayEl = overlayEl;
    this.onNodeActivate = onNodeActivate || (() => {});
    this.onAnchorEnter = onAnchorEnter || (() => {});
    this.onAnchorLeave = onAnchorLeave || (() => {});
    this.storageKey = storageKey || null;
    this._initialTransform = initialTransform || null; // deep-link 保存的初始视角（避免先 0.82 再跳）

    this.nodes = model.nodes;
    this.links = model.edges.map((e) => ({ ...e, source: e.from, target: e.to }));
    this.transform = d3.zoomIdentity;
    this.mode = 'show-all'; // show-all | show-modals-only
    this._edgeW = 1; // 边/箭头粗细倍率（1 = 当前最细）

    this._initSvg();
    this._initNodes();
    this._initSim();
    this._prewarm();
    this._initZoom();
    window.addEventListener('resize', () => this._resize());
    // 退出/切后台时记录稳定位置，下次加载据此初始化，避免大幅度抖动
    window.addEventListener('pagehide', () => this._savePositions());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this._savePositions(); });
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
    const saved = this._loadPositions();
    this._hasSaved = !!(saved && Object.keys(saved).length);
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
        if (ev.altKey) return; // Alt 是全屏平移手势，不触发节点展开
        if (ev.ctrlKey || ev.metaKey) { ev.stopPropagation(); self.ctx.modals && self.ctx.modals.togglePin(n); return; } // Ctrl+点击：pin/解锁节点
        ev.stopPropagation();
        self.onNodeActivate(n, el);
      });
      this._attachDrag(el, n);
      this.nodesEl.appendChild(el);
      this.nodeEls.set(n.id, el);
      const p = saved && saved[n.id];
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) { n.x = p.x; n.y = p.y; }
      else { n.x = (Math.random() - 0.5) * 600; n.y = (Math.random() - 0.5) * 600; }
    }
  }

  // 预热模拟：在首帧前静默 tick，让布局预先稳定，避免加载时大幅度位移
  _prewarm() {
    const n = this._hasSaved ? 40 : 160;
    for (let i = 0; i < n; i++) this.sim.tick();
    this.sim.alpha(0); // 冷却，等待用户交互再 reheat
  }

  _loadPositions() {
    if (!this.storageKey) return null;
    try { return JSON.parse(localStorage.getItem(this.storageKey) || 'null'); } catch { return null; }
  }
  _savePositions() {
    if (!this.storageKey) return;
    const map = {};
    for (const n of this.nodes) {
      if (Number.isFinite(n.x) && Number.isFinite(n.y)) map[n.id] = { x: Math.round(n.x), y: Math.round(n.y) };
    }
    try { localStorage.setItem(this.storageKey, JSON.stringify(map)); } catch { /* 容量/隐私模式忽略 */ }
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
    this.forceParams = { center: 0.3, charge: 540, link: 0.18 };

    this.linkForce = d3
      .forceLink(this.links)
      .id((d) => d.id)
      .distance((l) => 140 + (this.model.nodeById.get(l.source.id || l.source)?.radius || 30))
      .strength(this.forceParams.link);

    this.chargeForce = d3.forceManyBody().strength(() => -this.forceParams.charge);
    // forceCenter 仅防整体漂移（弱）；真正的"聚拢力"用 forceX/Y 向心，对孤立节点也有效
    this.centerForce = d3.forceCenter(0, 0).strength(0.05);
    this.forceX = d3.forceX(0).strength(this.forceParams.center);
    this.forceY = d3.forceY(0).strength(this.forceParams.center);

    // 只有“可见的圆节点”才占据碰撞体积；modal 与被隐藏节点（含“仅显示展开框”）半径为 0
    this._collideRadius = (d) => (this._nodeVisible(d) ? d.radius + 22 : 0);
    this.collideForce = d3.forceCollide().radius(this._collideRadius).strength(0.85).iterations(2);

    this.sim = d3
      .forceSimulation(this.nodes)
      .force('link', this.linkForce)
      .force('charge', this.chargeForce)
      .force('center', this.centerForce)
      .force('x', this.forceX)
      .force('y', this.forceY)
      .force('collide', this.collideForce)
      .force('rect', this._forceRect())
      .velocityDecay(0.42)
      .alphaDecay(0.028)
      .on('tick', () => this._tick())
      .on('end', () => this._savePositions());
  }

  // 调节力参数（N4）：name ∈ center|charge|link
  setForce(name, value) {
    this.forceParams[name] = value;
    if (name === 'center') { this.forceX.strength(value); this.forceY.strength(value); }
    else if (name === 'charge') this.chargeForce.strength(() => -value);
    else if (name === 'link') this.linkForce.strength(value);
    // 仅轻微 reheat：在现有布局基础上就地微调，避免把整个图重新拉回原点（“重置到一个固定点”）
    this.reheat(0.12);
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
        if (m._dragging || m.pinned) return; // 拖拽中 / 已锁定：不被力推走
        if (m.fx == null) m.fx = m.x;
        if (m.fy == null) m.fy = m.y;
        m.fx += ddx; m.fy += ddy;
      };

      // modal ↔ 圆：把圆推开，modal 仅轻微让位
      for (const m of modals) {
        const mcx = m.x + m.mw / 2, mcy = m.y + m.mh / 2; // PR4：卡片左上角 → 中心
        // pinned modal 不受 d3 center force 影响，这里给同等质量的中心牵引。
        if (!m._dragging) nudge(m, -mcx * this.forceParams.center * alpha * 1.2, -mcy * this.forceParams.center * alpha * 1.2);
        const hw = m.mw / 2 + PAD;
        const hh = m.mh / 2 + PAD;
        for (const o of nodes) {
          if (o === m || o.isModal || !this._nodeVisible(o)) continue; // 跳过被隐藏的圆（不占碰撞）
          const dx = o.x - mcx;
          const dy = o.y - mcy;
          const ox = hw + o.radius - Math.abs(dx);
          const oy = hh + o.radius - Math.abs(dy);
          if (ox > 0 && oy > 0) {
            if (ox < oy) {
              const push = (dx >= 0 ? 1 : -1) * ox;
              o.vx += push * 0.16;
              nudge(m, -push * 0.10, 0);
            } else {
              const push = (dy >= 0 ? 1 : -1) * oy;
              o.vy += push * 0.16;
              nudge(m, 0, -push * 0.10);
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
          const dx = (b.x + b.mw / 2) - (a.x + a.mw / 2); // PR4：用中心比较
          const dy = (b.y + b.mh / 2) - (a.y + a.mh / 2);
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
    // 滚轮缩放档位（%）：50/75/100/125/150/175/200 等 25% 对齐，并向两端延伸
    this.SNAP = [10, 12, 15, 18, 25, 33, 50, 75, 100, 125, 150, 175, 200, 230, 260].map((v) => v / 100);
    this._wheelAccum = 0;
    this._wheelDir = 0;

    this.zoom = d3
      .zoom()
      .scaleExtent([MIN_K, MAX_K])
      // 滚轮缩放由自定义处理（见下）；这里只管平移：节点 / modal / 详情页等上不触发平移
      .filter((ev) => {
        if (ev.type === 'wheel') return false; // 滚轮交给 _onWheel 处理（支持档位对齐 + 节点/短框上也可缩放）
        if (ev.altKey) return true; // 按住 Alt：任意位置（节点 / 卡片内容 / 标题上）都触发全屏平移
        const t = ev.target;
        if (t.closest && (t.closest('.node') || t.closest('.modal') || t.closest('.details-page') || t.closest('.zoom-control') || t.closest('.sidebar-rail'))) return false;
        return true;
      })
      .on('start', () => this.stageEl.classList.add('panning'))
      .on('zoom', (ev) => {
        this.transform = ev.transform;
        this._applyTransform();
      })
      .on('end', () => { this.stageEl.classList.remove('panning'); this.ctx && this.ctx.writeHash && this.ctx.writeHash(); });
    d3.select(this.stageEl).call(this.zoom).on('dblclick.zoom', null);

    // 自定义滚轮缩放：以光标为中心、对齐到档位
    this.stageEl.addEventListener('wheel', (ev) => this._onWheel(ev), { passive: false });
  }

  _onWheel(ev) {
    if (this.zoomLocked) return;
    const t = ev.target;
    // 缩放控件 / 折叠条 / 详情页：交给它们自己处理
    if (t.closest && (t.closest('.zoom-control') || t.closest('.sidebar-rail') || t.closest('.details-page'))) return;
    // 可滚动的展开框内容：让其内部滚动（远景形态除外；按住 Alt 时强制用于全屏缩放）
    const body = !ev.altKey && !this.lodFar && t.closest && t.closest('.modal-body');
    if (body && body.scrollHeight > body.clientHeight + 1) {
      const atTop = body.scrollTop <= 0;
      const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 1;
      const goingUp = ev.deltaY < 0;
      if (!((goingUp && atTop) || (!goingUp && atBottom))) return; // 还能滚就让它滚
    }
    ev.preventDefault();
    // 累积滚动量，达到阈值步进一档（兼容鼠标滚轮与触控板）
    const dir = ev.deltaY < 0 ? 1 : -1;
    if (dir !== this._wheelDir) { this._wheelAccum = 0; this._wheelDir = dir; }
    this._wheelAccum += Math.abs(ev.deltaY);
    if (this._wheelAccum < 25) return; // 阈值减半 → 滚轮缩放约 2x 速度
    this._wheelAccum = 0;
    // 按住 Ctrl：一次滚动跨多档（更大百分比的快速缩放）
    const steps = ev.ctrlKey ? 3 : 1;
    let next = this.transform.k;
    for (let i = 0; i < steps; i++) next = this._nextSnap(next, dir);
    if (Math.abs(next - this.transform.k) < 1e-4) return;
    const rect = this.stageEl.getBoundingClientRect();
    this._zoomToScale(next, ev.clientX - rect.left, ev.clientY - rect.top);
  }

  _nextSnap(k, dir) {
    const eps = 1e-3;
    if (dir > 0) {
      for (const s of this.SNAP) if (s > k + eps) return s;
      return this.SNAP[this.SNAP.length - 1];
    }
    for (let i = this.SNAP.length - 1; i >= 0; i--) if (this.SNAP[i] < k - eps) return this.SNAP[i];
    return this.SNAP[0];
  }

  // 缩放到指定比例，并让屏幕坐标 (px,py) 处的世界点保持不动
  _zoomToScale(k, px, py) {
    const next = clamp(k, MIN_K, MAX_K);
    const w = this.screenToWorld(px, py);
    const t = this._constrain(d3.zoomIdentity.translate(px - w.x * next, py - w.y * next).scale(next));
    d3.select(this.stageEl).transition().duration(140).call(this.zoom.transform, t);
  }

  // 用 d3-zoom 自身的 constrain 预约束程序化设置的变换：与拖拽手势的约束一致，
  // 避免“程序化变换未约束 → 首次拖动被重新约束而瞬移”。
  _constrain(t) {
    if (!this.zoom || !this.W) return t;
    const c = this.zoom.constrain();
    return c(t, [[0, 0], [this.W, this.H]], this.zoom.translateExtent());
  }

  _applyTransform() {
    const t = this.transform;
    this.zoomG.attr('transform', t);
    const css = `translate(${t.x}px, ${t.y}px) scale(${t.k})`;
    this.nodesEl.style.transform = css;
    this.overlayEl.style.transform = css;
    this._notifyOverlay && this._notifyOverlay();
    this._notifyZoom && this._notifyZoom(t.k);
    this._updateLod(t.k);
    this._scheduleSharp();
  }

  // 远景细节分级（LOD）：随缩放连续把节点淡化为实心圆点、展开框淡化为“大号节点”卡片
  _updateLod(k) {
    const HI = 0.45, LO = 0.35; // 45% 开始变化，35% 完全变化为远景形态
    const lod = Math.max(0, Math.min(1, (HI - k) / (HI - LO)));
    this.nodesEl.style.setProperty('--lod', lod.toFixed(3));
    this.overlayEl.style.setProperty('--lod', lod.toFixed(3));
    if (lod !== this._lod) {
      this._lod = lod;
      if (this.ctx && this.ctx.modals) this.ctx.modals.applyLod(lod); // 展开框高度随 lod 在自然高↔正方形间插值
    }
    // 进入/退出“远景形态”（完全变化点 35% 进入，带迟滞到 40% 退出，避免边界抖动）
    const far = this.lodFar ? k < 0.40 : k < 0.35;
    if (far !== this.lodFar) {
      this.lodFar = far;
      const app = this._appEl || (this._appEl = document.getElementById('app'));
      if (app) app.classList.toggle('lod-far', far);
    }
  }

  // 渐进式清晰度：缩放过程中保留 will-change（GPU 合成，流畅但位图放大略糊），
  // 停止 ~180ms 且放大倍率 >1 时移除 will-change，让展开框按当前比例重新栅格化变清晰。
  _scheduleSharp() {
    const app = this._appEl || (this._appEl = document.getElementById('app'));
    if (!app) return;
    app.classList.remove('render-sharp');
    clearTimeout(this._sharpTimer);
    this._sharpTimer = setTimeout(() => {
      if (this.transform.k > 1.05) app.classList.add('render-sharp');
    }, 180);
  }

  setOverlaySync(fn) { this._notifyOverlay = fn; }
  setZoomSync(fn) { this._notifyZoom = fn; fn && fn(this.transform.k); }
  setZoomLocked(on) { this.zoomLocked = !!on; }
  getZoomScale() { return this.transform.k; }
  setZoomScale(k) {
    const next = clamp(k, MIN_K, MAX_K);
    const cx = this.W / 2;
    const cy = this.H / 2;
    const w = this.screenToWorld(cx, cy);
    const t = this._constrain(d3.zoomIdentity.translate(cx - w.x * next, cy - w.y * next).scale(next));
    d3.select(this.stageEl).transition().duration(120).call(this.zoom.transform, t);
  }
  // 适应视图：把所有可见元素的外接矩形居中，并约占视口 fraction（默认 80%），平滑过渡
  fitView(fraction = 0.8) {
    const present = this.nodes.filter((n) => this.isNodePresent(n));
    if (!present.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of present) {
      let a, b, c, d;
      if (n.isModal) { a = n.x; b = n.y; c = n.x + (n.mw || 0); d = n.y + (n.mh || 0); }
      else { const r = n.radius || 0; a = n.x - r; b = n.y - r; c = n.x + r; d = n.y + r; }
      if (a < x0) x0 = a; if (b < y0) y0 = b; if (c > x1) x1 = c; if (d > y1) y1 = d;
    }
    const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const k = clamp(fraction * Math.min(this.W / bw, this.H / bh), MIN_K, MAX_K);
    const t = this._constrain(d3.zoomIdentity.translate(this.W / 2 - cx * k, this.H / 2 - cy * k).scale(k));
    d3.select(this.stageEl).transition().duration(460).ease(d3.easeCubicInOut).call(this.zoom.transform, t);
  }

  // 即时设置完整视角变换（用于 deep-link 恢复，无动画）
  setTransform(k, x, y) {
    const t = this._constrain(d3.zoomIdentity.translate(x || 0, y || 0).scale(clamp(k, MIN_K, MAX_K)));
    d3.select(this.stageEl).call(this.zoom.transform, t);
  }

  _resize() {
    const r = this.stageEl.getBoundingClientRect();
    this.W = r.width;
    this.H = r.height;
    // SVG 使用与 HTML 层一致的左上原点坐标系；缩放/平移统一交给 zoom transform。
    this.svg.attr('viewBox', `0 0 ${this.W} ${this.H}`).attr('width', this.W).attr('height', this.H);
    // 世界硬边界：15% 缩放铺满视口的范围，居中于世界原点；同时限制平移不越界
    const hw = (this.W / BOUND_ZOOM) / 2;
    const hh = (this.H / BOUND_ZOOM) / 2;
    this.worldBounds = { x0: -hw, y0: -hh, x1: hw, y1: hh };
    if (this.zoom) this.zoom.translateExtent([[-hw, -hh], [hw, hh]]);
    // 初次：有 deep-link 保存的视角则直接用它（首帧即就位，不先 0.82 再跳）；否则世界原点居中
    if (!this._centered) {
      const it = this._initialTransform;
      this.transform = this._constrain((it && Number.isFinite(it.k))
        ? d3.zoomIdentity.translate(it.x || 0, it.y || 0).scale(it.k)
        : d3.zoomIdentity.translate(this.W / 2, this.H / 2).scale(0.82));
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
      if (ev.altKey) return; // Alt：让事件冒泡给舞台做全屏平移，不拖拽节点
      ev.stopPropagation();
      sx = ev.clientX; sy = ev.clientY; ox = n.x; oy = n.y; moved = false;
      n.fx = n.x; n.fy = n.y;
      this.sim.alphaTarget(0.1).restart();
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
      if (!el) continue;
      const vis = this._nodeVisible(n);
      el.classList.toggle('node-hidden', !vis);
      n._visApplied = vis; // 与 _tick 的增量判断保持同步
    }
    this.refreshCollision();
    this._renderEdges();
    this.ctx && this.ctx.refLayer && this.ctx.refLayer.refreshRelations();
  }

  // 按当前可见性重算碰撞半径（modal 化 / 隐藏 / 仅显示展开框 都会改变占位）
  refreshCollision() {
    if (this.collideForce) this.collideForce.radius(this._collideRadius);
  }

  // 把所有元素夹在世界硬边界内（圆按半径、卡片按外接框留边），元素无法越界
  _clampToBounds() {
    const b = this.worldBounds;
    if (!b) return;
    for (const n of this.nodes) {
      if (n.isModal) {
        const w = n.mw || 0, h = n.mh || 0;
        n.x = clamp(n.x, b.x0, b.x1 - w);
        n.y = clamp(n.y, b.y0, b.y1 - h);
        if (n.fx != null) n.fx = clamp(n.fx, b.x0, b.x1 - w);
        if (n.fy != null) n.fy = clamp(n.fy, b.y0, b.y1 - h);
      } else {
        const r = n.radius || 0;
        n.x = clamp(n.x, b.x0 + r, b.x1 - r);
        n.y = clamp(n.y, b.y0 + r, b.y1 - r);
        if (n.fx != null) n.fx = clamp(n.fx, b.x0 + r, b.x1 - r);
        if (n.fy != null) n.fy = clamp(n.fy, b.y0 + r, b.y1 - r);
      }
    }
  }

  // ---- 边/箭头粗细 ----
  setEdgeWidth(mult) {
    this._edgeW = Math.max(1, +mult || 1);
    this.stageEl.style.setProperty('--edge-w', String(this._edgeW));
    this._renderEdges(); // 重算箭头尺寸/圆点半径
  }
  getEdgeWidth() { return this._edgeW; }

  // ---- 每帧更新 ----
  _tick() {
    this._clampToBounds();
    for (const n of this.nodes) {
      const el = this.nodeEls.get(n.id);
      if (!el) continue;
      const vis = this._nodeVisible(n);
      if (n._visApplied !== vis) { el.classList.toggle('node-hidden', !vis); n._visApplied = vis; } // 仅在变化时改 DOM
      if (!vis) continue; // 隐藏 / 已展开为 modal 的圆无需更新位置（_nodeVisible 对 modal 返回 false）
      const r = n.radius;
      el.style.transform = `translate(${n.x - r}px, ${n.y - r}px)`;
    }
    this._positionEdges();
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
    const w = node.mw || 100, h = node.mh || 100; // PR4：node.x/y 为左上角
    return kind === 'refs' ? { x: node.x, y: node.y + h / 2 } : { x: node.x + w, y: node.y + h / 2 };
  }

  // ---- 边渲染 ----
  // 完整重建：仅在可见边集合/拓扑变化（展开、过滤、模式切换、悬停高亮）时调用。
  _renderEdges() {
    const self = this;
    const visible = this.links.filter((l) => this._edgeVisible(l));
    this._visibleEdges = visible;
    for (const l of visible) this._computeEnds(l);

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

    // 圆点 datum 通过 __src 引用所属边对象，定位时复用边上缓存的 _p1/_p2
    const dotsData = visible.flatMap((d) => ([
      { from: d.from, fromLabel: d.fromLabel, to: d.to, end: 'from', __src: d },
      { from: d.from, fromLabel: d.fromLabel, to: d.to, end: 'to', __src: d },
    ]));
    const dots = this.gAnchors.selectAll('circle').data(dotsData, (d) => `${d.from}|${d.fromLabel}|${d.to}|${d.end}`);
    dots.exit().remove();
    const dotEnt = dots.enter().append('circle').attr('class', (d) => `edge-dot edge-dot-${d.end}`).attr('r', 3.2);
    // label 圆点（from 端）：点击查看所有引用该 label 的节点并展开（N10）
    dotEnt.each(function (d) {
      if (d.end !== 'from') return;
      this.addEventListener('pointerdown', (e) => e.stopPropagation());
      this.addEventListener('click', (e) => { e.stopPropagation(); self._onLabelDotClick(d, e); });
    });
    this.edgeDotSel = dotEnt.merge(dots);
    this.edgeDotSel.attr('r', (3.2 * (this._edgeW || 1)).toFixed(2));

    this._edgesDirty = false;
    this._applyEdgeAttrs(true);
  }

  // 每个可见边的端点只算一次，缓存到 l._p1 / l._p2
  _computeEnds(l) {
    const a = this.model.nodeById.get(l.from);
    const b = this.model.nodeById.get(l.to);
    l._p1 = a ? this.anchorPos(a, l.fromLabel) : { x: 0, y: 0 };
    l._p2 = b ? this.refsPos(b) : { x: 0, y: 0 };
  }

  // 写入路径/箭头/圆点的几何属性；withClasses=true 时一并刷新 hi/dimmed 状态类
  _applyEdgeAttrs(withClasses) {
    const self = this;
    const e = this.edgeSel.attr('d', (l) => self._edgePathFrom(l._p1, l._p2));
    const a = this.arrowSel.attr('points', (l) => self._arrowPointsFrom(l._p1, l._p2));
    const d = this.edgeDotSel
      .attr('cx', (o) => (o.end === 'from' ? o.__src._p1 : o.__src._p2).x)
      .attr('cy', (o) => (o.end === 'from' ? o.__src._p1 : o.__src._p2).y);
    if (withClasses) {
      e.classed('hi', (l) => !!l._hi).classed('dimmed', (l) => !!l._dim);
      a.classed('hi', (l) => !!l._hi);
      d.classed('hi', (o) => !!o.__src._hi).classed('dimmed', (o) => !!o.__src._dim);
    }
  }

  // 每帧轻量定位：复用已建好的选择集，只重算端点并写几何属性，避免重做数据连接。
  _positionEdges() {
    if (!this.edgeSel || this._edgesDirty || !this._visibleEdges) return this._renderEdges();
    // 可见边集合数量变化（展开/隐藏/模式切换）→ 退回完整重建
    let count = 0;
    for (const l of this.links) if (this._edgeVisible(l)) count++;
    if (count !== this._visibleEdges.length) return this._renderEdges();
    for (const l of this._visibleEdges) this._computeEnds(l);
    this._applyEdgeAttrs(false);
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

  _edgePathFrom(p1, p2) {
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

  _arrowPointsFrom(p1, p2) {
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const ang = Math.atan2(dy, dx);
    const size = 7 * (this._edgeW || 1);
    const tipX = p2.x - Math.cos(ang) * 3;
    const tipY = p2.y - Math.sin(ang) * 3;
    const a1 = ang + Math.PI - 0.4;
    const a2 = ang + Math.PI + 0.4;
    return `${tipX},${tipY} ${tipX + Math.cos(a1) * size},${tipY + Math.sin(a1) * size} ${tipX + Math.cos(a2) * size},${tipY + Math.sin(a2) * size}`;
  }

  // ---- 公共 API ----
  setMode(mode) {
    this.mode = mode;
    this.updateVisibility();
    this._tick();
    // 切换视图后碰撞体积/可见集变化：从现有位置轻微 warm 适配，不做全局重排
    this.reheat(0.2);
  }

  reheat(a = 0.5) { this.sim.alpha(a).restart(); }

  worldToScreen(x, y) {
    return { x: x * this.transform.k + this.transform.x, y: y * this.transform.k + this.transform.y };
  }
  screenToWorld(sx, sy) {
    return { x: (sx - this.transform.x) / this.transform.k, y: (sy - this.transform.y) / this.transform.k };
  }

  highlightNeighbors(nodeId, on) {
    this._hoverId = on ? nodeId : null;
    if (!on) {
      this.nodeEls.forEach((el) => el.classList.remove('dimmed'));
      this._dimModals(false);
      this.links.forEach((l) => { l._hi = false; l._dim = false; });
      this._renderEdges();
      return;
    }
    const alt = this._altHeld(); // 按住 Alt：保留关联高亮但不把无关元素变灰（PR2）
    const keep = new Set([nodeId]);
    for (const m of this.model.deps.get(nodeId) || []) keep.add(m);
    for (const m of this.model.usedBy.get(nodeId) || []) keep.add(m);
    this.nodeEls.forEach((el, id) => el.classList.toggle('dimmed', !alt && !keep.has(id)));
    this._dimModals(!alt, keep);
    this.links.forEach((l) => {
      l._hi = l.from === nodeId || l.to === nodeId;
      l._dim = alt ? false : !(keep.has(l.from) && keep.has(l.to));
    });
    this._renderEdges();
  }
  _altHeld() { const a = this._appEl || (this._appEl = document.getElementById('app')); return !!a && a.classList.contains('alt-pan'); }

  // 关联高亮时一并处理展开框：无关 modal 变灰，关联 modal 保持原样
  _dimModals(on, keep) {
    if (!this.ctx || !this.ctx.modals) return;
    for (const rec of this.ctx.modals.open.values()) {
      rec.el.classList.toggle('rel-dim', !!on && !!keep && !keep.has(rec.node.id));
    }
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
    // PR4：卡片以左上角定位，聚焦时取其中心
    const px = n.isModal ? n.x + (n.mw || 0) / 2 : n.x;
    const py = n.isModal ? n.y + (n.mh || 0) / 2 : n.y;
    const t = d3.zoomIdentity.translate(this.W / 2 - px * scale, this.H / 2 - py * scale).scale(scale);
    d3.select(this.stageEl).transition().duration(550).call(this.zoom.transform, t);
  }

  // 仅平移（不改变缩放）使某展开框完整出现在视口可见区内（N11）
  panToShowModal(nodeId) {
    const rec = this.ctx && this.ctx.modals && this.ctx.modals.open.get(nodeId);
    if (!rec) return;
    const mr = rec.el.getBoundingClientRect();
    const sr = this.stageEl.getBoundingClientRect();
    const app = this._appEl || (this._appEl = document.getElementById('app'));
    const sidebarW = app && !app.classList.contains('sidebar-collapsed') ? 280 : 0;
    const pad = 28;
    const viewL = sr.left + sidebarW + pad, viewR = sr.right - pad;
    const viewT = sr.top + pad, viewB = sr.bottom - pad;
    let dx = 0, dy = 0;
    if (mr.left < viewL) dx = viewL - mr.left;
    else if (mr.right > viewR) dx = Math.max(viewR - mr.right, viewL - mr.left);
    if (mr.top < viewT) dy = viewT - mr.top;
    else if (mr.bottom > viewB) dy = Math.max(viewB - mr.bottom, viewT - mr.top);
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    const t = d3.zoomIdentity.translate(this.transform.x + dx, this.transform.y + dy).scale(this.transform.k);
    d3.select(this.stageEl).transition().duration(420).call(this.zoom.transform, t);
  }

  // 点击 label 圆点：列出所有引用该 label 的节点，可逐个或一次性展开（N10）
  _onLabelDotClick(d, ev) {
    this._closeLabelMenu();
    const targets = this.links
      .filter((l) => l.from === d.from && l.fromLabel === d.fromLabel && this._edgeVisible(l))
      .map((l) => this.model.nodeById.get(l.to))
      .filter((n, i, arr) => n && arr.indexOf(n) === i);
    if (!targets.length) return;
    const ownerLab = (() => {
      const owner = this.model.nodeById.get(d.from);
      const lab = owner && owner.labels && owner.labels.find((l) => l.id === d.fromLabel);
      return lab ? `${nodeTag(this.model, owner)}` : (owner ? nodeTag(this.model, owner) : d.fromLabel);
    })();
    const menu = document.createElement('div');
    menu.className = 'label-dot-menu';
    const open = (n) => { this.ctx.modals.openFromNode(n); if (!isLeafNode(this.model, n)) this.panToShowModal(n.id); };
    const head = document.createElement('div');
    head.className = 'ldm-head';
    head.innerHTML = `<span>引用 ${escapeHtml(ownerLab)} 的 ${targets.length} 项</span>`;
    const allBtn = document.createElement('button');
    allBtn.className = 'ldm-all';
    allBtn.textContent = '全部展开';
    allBtn.addEventListener('click', () => { targets.forEach(open); this._closeLabelMenu(); });
    head.appendChild(allBtn);
    menu.appendChild(head);
    for (const n of targets) {
      const item = document.createElement('button');
      item.className = 'ldm-item';
      item.innerHTML = `<span class="ldm-tag" style="color:${typeColor(this.model, n.type)}">${escapeHtml(nodeTag(this.model, n))}</span><span class="ldm-title">${escapeHtml(n.title || n.id)}</span>`;
      item.addEventListener('click', () => { open(n); this._closeLabelMenu(); });
      menu.appendChild(item);
    }
    document.body.appendChild(menu);
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let x = ev.clientX + 8, y = ev.clientY + 8;
    if (x + mw > window.innerWidth - 8) x = window.innerWidth - mw - 8;
    if (y + mh > window.innerHeight - 8) y = window.innerHeight - mh - 8;
    menu.style.left = `${Math.max(8, x)}px`;
    menu.style.top = `${Math.max(8, y)}px`;
    this._labelMenu = menu;
    const onDoc = (e) => { if (this._labelMenu && !this._labelMenu.contains(e.target)) this._closeLabelMenu(); };
    this._labelMenuDoc = onDoc;
    setTimeout(() => document.addEventListener('pointerdown', onDoc, true), 0);
  }
  _closeLabelMenu() {
    if (this._labelMenu) { this._labelMenu.remove(); this._labelMenu = null; }
    if (this._labelMenuDoc) { document.removeEventListener('pointerdown', this._labelMenuDoc, true); this._labelMenuDoc = null; }
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
