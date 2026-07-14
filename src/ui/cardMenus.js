// =============================================================================
// ui/cardMenus.js  —  卡片正文的「选中文字 simple-menu」与「右键菜单」
//   · 选中文字（非打标模式）→ 横向 simple-menu：复制 / 最近3标签 / 省略号二级；
//     有序标签项显示 n+1 的 tm-idx，hover≥1.5s 展开插入序号行。
//   · 右键空白/未选中 → menu-blank（图标+文字）：复制▸ / 固定 / 关闭为节点 / 隐藏 /
//     常用3标签 / 更多标签此处打标(location)▸  —— 标签动作建 pos 成员。
//   · 右键选中文字 → 关闭 simple-menu，光标处普通 menu：常用3标签 / 更多标签文字打标(alphabet)▸
//     —— 标签动作建 span 成员。
// =============================================================================
import { ICON } from './icons.js';
import { toast } from './feedback.js';

const el = (cls, tag = 'div') => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 选区 → 源码文本：把 KaTeX 渲染块还原为其原始 LaTeX（取 annotation），而非逐符号渲染文本
export function selectionSource(sel) {
  if (!sel || sel.rangeCount === 0) return '';
  const div = document.createElement('div');
  div.appendChild(sel.getRangeAt(0).cloneContents());
  div.querySelectorAll('.katex').forEach((k) => {
    const ann = k.querySelector('annotation[encoding="application/x-tex"]');
    const src = ann ? ann.textContent : '';
    const display = !!k.closest('.math-display, .katex-display');
    k.replaceWith(document.createTextNode(src ? (display ? `$$${src}$$` : `$${src}$`) : (k.textContent || '')));
  });
  return div.textContent.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function initCardMenus(ctx) {
  let simple = null;        // 当前 simple-menu
  let popup = null;         // 当前右键弹出菜单（含二级）
  let lastSelKey = '';      // 上次 simple-menu 对应选区，避免重复

  const bodyAt = (target) => {
    if (!ctx.modals) return null;
    for (const [nodeId, rec] of ctx.modals.open) {
      if (rec.el.contains(target)) { const body = rec.el.querySelector('.modal-body'); return body && body.contains(target) ? { nodeId, body } : null; }
    }
    return null;
  };
  const selInBody = (body) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return null;
    if (!body.contains(sel.anchorNode) || !body.contains(sel.focusNode)) return null;
    return sel;
  };

  // ---------- simple-menu ----------
  function closeSimple() { if (simple) { simple.el.remove(); document.removeEventListener('pointerdown', onDocDownS, true); document.removeEventListener('pointermove', onDocMoveS, true); simple = null; } }
  function onDocDownS(e) { if (simple && !simple.el.contains(e.target)) closeSimple(); }
  function onDocMoveS(e) {
    if (!simple) return;
    const r = simple.el.getBoundingClientRect();
    const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right);
    const dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
    if (Math.hypot(dx, dy) > 48) closeSimple();
  }

  function showSimple(body, nodeId, sel) {
    closeSimple();
    const baseSpan = ctx.spanFromSelection(body, nodeId, sel);
    if (!baseSpan) return;
    const rects = sel.getRangeAt(0).getClientRects(); const last = rects[rects.length - 1];
    if (!last) return;
    const menu = el('card-simple-menu');
    // 复制选中（源码）
    const selectedSource = selectionSource(sel);
    menu.appendChild(iconBtn(ICON.copy, '复制选中', () => { copy(selectedSource); closeSimple(); }));
    menu.appendChild(iconBtn(ICON.aiAdd, '添加到 AI', () => {
      ctx.aiPanel?.attachSelection({ ...baseSpan, text: selectedSource });
      closeSimple();
    }));
    // 常用 3 标签
    for (const tag of ctx.commonTags(3)) menu.appendChild(tagBtn(tag, baseSpan, () => closeSimple()));
    // 省略号 → 其余标签二级
    const rest = ctx.graph.getTags().filter((t) => !ctx.commonTags(3).includes(t));
    if (rest.length) {
      const more = iconBtn(ICON.more, '更多标签', (e) => openSubMenu(e.currentTarget, rest, baseSpan, () => closeSimple()));
      menu.appendChild(more);
    }
    document.body.appendChild(menu);
    // 定位在选区末字符处
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let x = last.right, y = last.bottom + 6;
    if (x + mw > window.innerWidth - 6) x = window.innerWidth - mw - 6;
    if (y + mh > window.innerHeight - 6) y = last.top - mh - 6;
    menu.style.left = `${Math.max(6, x)}px`; menu.style.top = `${Math.max(6, y)}px`;
    simple = { el: menu };
    setTimeout(() => { document.addEventListener('pointerdown', onDocDownS, true); document.addEventListener('pointermove', onDocMoveS, true); }, 0);
  }

  // 一个标签按钮：有序→tm-idx(n+1)，hover1.5s 展开插入行；无序→图标
  function tagBtn(tag, baseSpan, onDone) {
    const b = el('card-sm-tag', 'button');
    b.style.setProperty('--tc', tag.color || '#ff9e64');
    b.title = tag.label || (tag.kind === 'ordered' ? '有序标签' : '标签');
    if (tag.kind === 'ordered') { const n = tag.members.length; b.innerHTML = `<span class="tm-idx">${n + 1}</span>`; }
    else b.innerHTML = `<span class="csm-ic">${ICON[tag.icon] || ICON.tag}</span>`;
    let timer = null, row = null;
    b.addEventListener('click', (e) => { if (e.target.closest('.csm-insert')) return; ctx.addMember(tag.id, { ...baseSpan }); onDone(); });
    if (tag.kind === 'ordered') {
      b.addEventListener('mouseenter', () => { timer = setTimeout(() => { row = buildInsertRow(tag, baseSpan, onDone); b.appendChild(row); }, 1500); });
      b.addEventListener('mouseleave', (e) => { clearTimeout(timer); if (row && !b.contains(e.relatedTarget)) { row.remove(); row = null; } });
    }
    return b;
  }

  // 插入序号行：左=即将插入的 tm-idx（实时），分隔线，右=1..n 只读，间隙竖条点击插入
  function buildInsertRow(tag, baseSpan, onDone) {
    const n = tag.members.length;
    const row = el('csm-insert');
    const prev = el('tm-idx csm-prev'); prev.textContent = String(n + 1);
    row.appendChild(prev);
    row.appendChild(el('csm-div'));
    const list = el('csm-list');
    for (let p = 0; p <= n; p += 1) {
      const gap = el('csm-gap', 'button');
      gap.addEventListener('mouseenter', () => { prev.textContent = String(p + 1); });
      gap.addEventListener('click', (e) => { e.stopPropagation(); ctx.addMember(tag.id, { ...baseSpan }, p); onDone(); });
      list.appendChild(gap);
      if (p < n) { const pill = el('tm-idx csm-exist'); pill.textContent = String(p + 1); list.appendChild(pill); }
    }
    row.appendChild(list);
    return row;
  }

  // ---------- 二级 / 右键菜单（图标+文字，复用 .m-menu 样式） ----------
  function closePopup() { if (popup) { popup.remove(); document.removeEventListener('pointerdown', onDocDownP, true); popup = null; } if (window.__cardSub) { window.__cardSub.remove(); window.__cardSub = null; } }
  function onDocDownP(e) { if (popup && !popup.contains(e.target) && !(window.__cardSub && window.__cardSub.contains(e.target))) closePopup(); }

  function menuItem(iconSvg, label, onClick, hasSub) {
    const it = el('m-menu-item');
    const main = el('mm-main', 'button');
    main.innerHTML = `<span class="mm-ic">${iconSvg || ''}</span><span class="mm-txt">${esc(label)}</span>${hasSub ? '<span class="mm-arrow">▸</span>' : ''}`;
    if (onClick) main.addEventListener(hasSub ? 'mouseenter' : 'click', (e) => onClick(e, main));
    it.appendChild(main);
    return it;
  }

  function openMenuAt(x, y, items) {
    closePopup();
    const menu = el('m-menu card-menu');
    for (const it of items) menu.appendChild(it);
    document.body.appendChild(menu);
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - mw - 6))}px`;
    menu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - mh - 6))}px`;
    popup = menu;
    setTimeout(() => document.addEventListener('pointerdown', onDocDownP, true), 0);
  }
  function openSubMenu(anchor, tags, baseMember, onDone) {
    if (window.__cardSub) window.__cardSub.remove();
    const sub = el('m-menu card-submenu');
    for (const tag of tags) {
      const it = menuItem(tag.kind === 'ordered' ? `<span class="tm-idx" style="--tc:${tag.color}">${tag.members.length + 1}</span>` : (ICON[tag.icon] || ICON.tag), tag.label || '（未命名）', () => { ctx.addMember(tag.id, typeof baseMember === 'function' ? baseMember() : { ...baseMember }); closeSimple(); closePopup(); onDone && onDone(); });
      sub.appendChild(it);
    }
    document.body.appendChild(sub);
    const r = anchor.getBoundingClientRect();
    sub.style.left = `${Math.min(r.right + 2, window.innerWidth - sub.offsetWidth - 6)}px`;
    sub.style.top = `${Math.max(6, Math.min(r.top, window.innerHeight - sub.offsetHeight - 6))}px`;
    window.__cardSub = sub;
  }

  // 右键空白 → menu-blank（标签动作建 pos）
  function showBlankMenu(body, nodeId, cx, cy) {
    closeSimple();
    const rec = ctx.modals.open.get(nodeId); const node = ctx.model.nodeById.get(nodeId);
    const posFactory = () => ctx.posFromPoint(body, nodeId, cx, cy);
    const items = [];
    const copyIt = menuItem(ICON.copy, '复制', (e, anchor) => openCopySub(anchor, nodeId), true);
    items.push(copyIt);
    items.push(menuItem(ICON.aiAdd, '添加整个内容到 AI', () => { ctx.aiPanel?.attachNode(nodeId); closePopup(); }));
    items.push(menuItem(ICON.pin, '固定', () => { ctx.modals.togglePin(node); closePopup(); }));
    items.push(menuItem(ICON.circle, '关闭为节点', () => { ctx.modals.closeModal(nodeId); closePopup(); }));
    items.push(menuItem(ICON.eyeOff, '隐藏', () => { ctx.hideNode(nodeId); closePopup(); }));
    for (const tag of ctx.commonTags(3)) items.push(menuItem(tag.kind === 'ordered' ? `<span class="tm-idx" style="--tc:${tag.color}">${tag.members.length + 1}</span>` : (ICON[tag.icon] || ICON.tag), tag.label || '（未命名）', () => { ctx.addMember(tag.id, posFactory()); closePopup(); }));
    items.push(menuItem(ICON.location, '更多标签此处打标', (e, anchor) => openSubMenu(anchor, ctx.graph.getTags(), posFactory), true));
    openMenuAt(cx, cy, items);
  }
  function openCopySub(anchor, nodeId) {
    if (window.__cardSub) window.__cardSub.remove();
    const node = ctx.model.nodeById.get(nodeId);
    const sub = el('m-menu card-submenu');
    const add = (label, text) => { const it = menuItem('', label, () => { copy(text); closePopup(); }); sub.appendChild(it); };
    add('复制所有内容', [node.title, node.statementBody, node.proofBody].filter(Boolean).join('\n\n'));
    add('复制标题', node.title || node.id);
    const selText = window.getSelection() ? selectionSource(window.getSelection()) : '';
    if (selText.trim()) add('复制选中', selText);
    document.body.appendChild(sub);
    const r = anchor.getBoundingClientRect();
    sub.style.left = `${Math.min(r.right + 2, window.innerWidth - sub.offsetWidth - 6)}px`;
    sub.style.top = `${Math.max(6, r.top)}px`;
    window.__cardSub = sub;
  }

  // 右键选中文字 → menu（标签动作建 span）
  function showSelectionMenu(body, nodeId, sel, cx, cy) {
    closeSimple();
    const baseSpan = ctx.spanFromSelection(body, nodeId, sel);
    const items = [];
    const selectedSource = selectionSource(sel);
    items.push(menuItem(ICON.copy, '复制选中', () => { copy(selectedSource); closePopup(); }));
    items.push(menuItem(ICON.aiAdd, '添加到 AI', () => { ctx.aiPanel?.attachSelection({ ...baseSpan, text: selectedSource }); closePopup(); }));
    for (const tag of ctx.commonTags(3)) items.push(menuItem(tag.kind === 'ordered' ? `<span class="tm-idx" style="--tc:${tag.color}">${tag.members.length + 1}</span>` : (ICON[tag.icon] || ICON.tag), tag.label || '（未命名）', () => { ctx.addMember(tag.id, { ...baseSpan }); closePopup(); }));
    items.push(menuItem(ICON.alphabet, '更多标签文字打标', (e, anchor) => openSubMenu(anchor, ctx.graph.getTags(), () => ({ ...baseSpan })), true));
    openMenuAt(cx, cy, items);
  }

  // ---------- 工具 ----------
  function iconBtn(svg, title, onClick) { const b = el('csm-btn', 'button'); b.title = title; b.innerHTML = svg || ''; b.addEventListener('click', onClick); return b; }
  function copy(text) { try { navigator.clipboard.writeText(text || ''); toast('已复制'); } catch { toast('复制失败', { type: 'error' }); } }

  // ---------- 事件绑定 ----------
  document.addEventListener('mouseup', (e) => {
    if (ctx.tagEditing) return; // 打标模式由 main 处理（自动打标）
    const c = bodyAt(e.target); if (!c) return;
    setTimeout(() => {
      const sel = selInBody(c.body); if (!sel) return;
      const key = sel.toString();
      lastSelKey = key;
      showSimple(c.body, c.nodeId, sel);
    }, 0);
  }, true);

  // 原生 Ctrl+C：卡片正文内复制源码（KaTeX 还原 LaTeX）
  document.addEventListener('copy', (e) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const anc = sel.anchorNode; const ael = anc && (anc.nodeType === 1 ? anc : anc.parentElement);
    if (!ael || !ael.closest('.modal-body')) return;
    const src = selectionSource(sel);
    if (src && e.clipboardData) { e.clipboardData.setData('text/plain', src); e.preventDefault(); }
  }, true);

  document.addEventListener('contextmenu', (e) => {
    const c = bodyAt(e.target); if (!c) return;
    e.preventDefault();
    const sel = selInBody(c.body);
    if (sel) showSelectionMenu(c.body, c.nodeId, sel, e.clientX, e.clientY);
    else showBlankMenu(c.body, c.nodeId, e.clientX, e.clientY);
  }, true);
}
