/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { choiceDialog, confirmDialog } from '../src/ui/feedback.js';

describe('custom confirmation dialog', () => {
  afterEach(() => {
    document.querySelectorAll('.confirm-back').forEach((element) => element.remove());
    vi.restoreAllMocks();
  });

  it('returns the selected value from a reusable multi-action dialog', async () => {
    const pending = choiceDialog({
      title: '删除标注',
      message: '此标注有笔记',
      actions: [
        { value: 'delete', label: '同时删除', tone: 'danger' },
        { value: 'move', label: '归属到节点' },
        { value: 'cancel', label: '取消' },
      ],
      cancelValue: 'cancel',
    });
    const dialog = document.querySelector('.confirm-back');
    expect(dialog).not.toBeNull();
    expect(dialog.querySelector('.confirm-actions').classList.contains('is-multi')).toBe(true);
    dialog.querySelector('[data-value="move"]').click();
    await expect(pending).resolves.toBe('move');
  });

  it('keeps the boolean confirm API compatible', async () => {
    const pending = confirmDialog({ title: '确认', message: '继续？', danger: true });
    document.querySelector('.btn--danger').click();
    await expect(pending).resolves.toBe(true);
  });
});
