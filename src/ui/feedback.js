// =============================================================================
// ui/feedback.js  —  自定义提示：toast（自动消失） + confirmDialog（Promise<bool>）
//   取代原生 alert / confirm，统一悬浮框风格、可叠加在弹窗之上。
// =============================================================================

let toastWrap = null;

export function toast(message, opts = {}) {
  const { type = 'info', duration = 3400 } = opts;
  if (!toastWrap) {
    toastWrap = document.createElement('div');
    toastWrap.className = 'toast-wrap';
    document.body.appendChild(toastWrap);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  toastWrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  const close = () => { el.classList.remove('in'); setTimeout(() => el.remove(), 200); };
  const timer = setTimeout(close, duration);
  el.addEventListener('click', () => { clearTimeout(timer); close(); });
  return close;
}

export function confirmDialog({ title = '', message = '', okText = '确定', cancelText = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'confirm-back';
    back.innerHTML = `
      <div class="confirm-pop" role="dialog" aria-modal="true">
        ${title ? `<div class="confirm-title">${esc(title)}</div>` : ''}
        <div class="confirm-msg">${esc(message)}</div>
        <div class="confirm-actions">
          <button class="btn btn--sm" data-cancel>${esc(cancelText)}</button>
          <button class="btn btn--sm ${danger ? 'btn--danger' : 'btn--primary'}" data-ok>${esc(okText)}</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const onKey = (e) => {
      if (e.key === 'Escape') done(false);
      else if (e.key === 'Enter') done(true);
    };
    const done = (v) => { back.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    back.querySelector('[data-ok]').addEventListener('click', () => done(true));
    back.querySelector('[data-cancel]').addEventListener('click', () => done(false));
    back.addEventListener('click', (e) => { if (e.target === back) done(false); });
    document.addEventListener('keydown', onKey, true);
    back.querySelector('[data-ok]').focus();
  });
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
