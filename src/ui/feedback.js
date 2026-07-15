// =============================================================================
// ui/feedback.js  —  自定义提示：toast + 可复用的多操作确认框。
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

export function choiceDialog({ title = '', message = '', actions = [], cancelValue = null, className = '' } = {}) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = `confirm-back${className ? ` ${className}` : ''}`;
    back.innerHTML = `
      <div class="confirm-pop" role="dialog" aria-modal="true"${title ? ' aria-labelledby="confirm-dialog-title"' : ' aria-label="确认"'}>
        ${title ? `<div class="confirm-title" id="confirm-dialog-title">${esc(title)}</div>` : ''}
        <div class="confirm-msg">${esc(message)}</div>
        <div class="confirm-actions${actions.length > 2 ? ' is-multi' : ''}"></div>
      </div>`;
    document.body.appendChild(back);
    const actionWrap = back.querySelector('.confirm-actions');
    const normalized = actions.length ? actions : [{ value: true, label: '确定', tone: 'primary', default: true }];
    const buttons = new Map();
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      back.classList.remove('in');
      document.removeEventListener('keydown', onKey, true);
      setTimeout(() => back.remove(), 140);
      resolve(value);
    };
    for (const action of normalized) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `btn btn--sm confirm-action${action.tone === 'danger' ? ' btn--danger' : action.tone === 'primary' ? ' btn--primary' : ''}`;
      button.textContent = action.label;
      if (action.description) button.title = action.description;
      button.dataset.value = String(action.value ?? '');
      button.addEventListener('click', () => done(action.value));
      actionWrap.appendChild(button);
      buttons.set(action, button);
    }
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(cancelValue); }
      else if (e.key === 'Enter') {
        const action = normalized.find((item) => item.default);
        if (action) { e.preventDefault(); done(action.value); }
      }
    };
    back.addEventListener('click', (e) => { if (e.target === back) done(cancelValue); });
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => {
      back.classList.add('in');
      const preferred = normalized.find((action) => action.autofocus)
        || normalized.find((action) => action.value === cancelValue)
        || normalized.find((action) => action.default)
        || normalized[0];
      buttons.get(preferred)?.focus();
    });
  });
}

export async function confirmDialog({ title = '', message = '', okText = '确定', cancelText = '取消', danger = false } = {}) {
  return choiceDialog({
    title,
    message,
    cancelValue: false,
    actions: [
      { value: false, label: cancelText, autofocus: danger },
      { value: true, label: okText, tone: danger ? 'danger' : 'primary', default: !danger },
    ],
  });
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
