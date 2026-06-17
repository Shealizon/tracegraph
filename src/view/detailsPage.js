// =============================================================================

import { isLeafNode, nodeTag, typeColor } from '../data/schema.js';
import { ICON } from '../ui/icons.js';
// view/detailsPage.js  —  Phase 7 全屏详情页
//   显示论述完整内容（statement + proof）、引用列表、被引用列表、文献信息
// =============================================================================

export function openDetails(ctx, nodeId) {
  const { model, render } = ctx;
  const node = model.nodeById.get(nodeId);
  if (!node) return;
  const proofLabel = model.meta.profileResolved?.id === 'paper' ? '证明' : '详情';

  const page = document.createElement('div');
  page.className = 'details-page';

  if (isLeafNode(model, node)) {
    page.innerHTML = `
      <div class="details-head">
        <span class="d-num" style="color:${typeColor(model, node.type)}">${escapeHtml(nodeTag(model, node))}</span>
        <span class="d-title">${escapeHtml(node.title)}</span>
        <button class="m-btn d-close" title="关闭">${ICON.close}</button>
      </div>
      <div class="details-cols">
        <div class="details-main"><p>来源条目 <code>${escapeHtml(node.id)}</code>。</p>${citedByHTML(ctx, node)}</div>
      </div>`;
  } else {
    const deps = [...(model.deps.get(node.id) || [])];
    const usedBy = [...(model.usedBy.get(node.id) || [])];
    page.innerHTML = `
      <div class="details-head">
        <span class="d-num" style="color:${typeColor(model, node.type)}">${escapeHtml(nodeTag(model, node))}</span>
        <span class="d-title">${escapeHtml(node.title || '')}</span>
        <button class="m-btn d-close" title="关闭">${ICON.close}</button>
      </div>
      <div class="details-cols">
        <div class="details-main">
          <div class="statement">${ctx.getRendered ? ctx.getRendered(node.id, 'statement') : render(node.statementBody)}</div>
          ${node.proofBody ? `<div class="proof-wrap"><div class="proof-label">${escapeHtml(proofLabel)}.</div>${ctx.getRendered ? ctx.getRendered(node.id, 'proof') : render(node.proofBody)}</div>` : ''}
        </div>
        <div class="details-side">
          <h4>依赖（本结论引用 ${deps.length}）</h4>
          ${refLines(ctx, deps)}
          <h4>被使用（引用本结论 ${usedBy.length}）</h4>
          ${refLines(ctx, usedBy)}
          <h4>重要度</h4>
          <div class="ref-line">I = ${node.importance} · deg_out ${node.degOut} / deg_in ${node.degIn}${node.inCycle ? ' · 处于环中（按度数）' : ''}</div>
        </div>
      </div>`;
  }

  document.body.appendChild(page);
  page.querySelector('.d-close').addEventListener('click', () => page.remove());
  page.addEventListener('keydown', (e) => { if (e.key === 'Escape') page.remove(); });
  const onEsc = (e) => { if (e.key === 'Escape') { page.remove(); window.removeEventListener('keydown', onEsc); } };
  window.addEventListener('keydown', onEsc);

  // 侧栏链接：点击 -> 跳转到该详情
  page.querySelectorAll('.ref-line[data-goto]').forEach((line) => {
    line.addEventListener('click', () => { page.remove(); openDetails(ctx, line.dataset.goto); });
  });
}

function refLines(ctx, ids) {
  const { model } = ctx;
  if (!ids.length) return `<div class="ref-line" style="color:var(--text-dim)">（无）</div>`;
  return ids
    .map((id) => {
      const n = model.nodeById.get(id);
      if (!n) return '';
      const tag = nodeTag(model, n);
      return `<div class="ref-line" data-goto="${escapeAttr(id)}"><span class="tag">${tag}</span>${escapeHtml(n.title || n.id)}</div>`;
    })
    .join('');
}

function citedByHTML(ctx, bibNode) {
  const { model } = ctx;
  const users = [...(model.usedBy.get(bibNode.id) || [])];
  if (!users.length) return '';
  return `<h4 style="margin-top:20px">被引用于</h4>` + refLines(ctx, users);
}

function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }
