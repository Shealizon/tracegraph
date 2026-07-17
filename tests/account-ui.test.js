// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ changePassword: vi.fn() }));
const feedback = vi.hoisted(() => ({ toast: vi.fn() }));
const session = vi.hoisted(() => ({ login: vi.fn(), logout: vi.fn(), register: vi.fn() }));
const sync = vi.hoisted(() => ({ syncNow: vi.fn() }));

vi.mock('../src/cloud/api.js', () => ({ serverApi: api }));
vi.mock('../src/cloud/session.js', () => ({
  ...session,
  sessionSnapshot: () => ({ user: { id: 'user', role: 'user' }, serverReachable: true }),
}));
vi.mock('../src/cloud/sync.js', () => sync);
vi.mock('../src/ui/feedback.js', () => feedback);

import { openAuthDialog, openChangePasswordDialog } from '../src/cloud/accountUi.js';

describe('account password UI', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    api.changePassword.mockReset();
    api.changePassword.mockResolvedValue(null);
    feedback.toast.mockReset();
    session.login.mockReset();
    session.login.mockResolvedValue(null);
    sync.syncNow.mockReset();
    sync.syncNow.mockResolvedValue(null);
  });

  it('validates confirmation and submits the current and new password', async () => {
    openChangePasswordDialog();
    const form = document.querySelector('.auth-dialog');
    form.elements.namedItem('currentPassword').value = 'old-password';
    form.elements.namedItem('newPassword').value = 'new-password';
    form.elements.namedItem('confirmPassword').value = 'different-password';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(api.changePassword).not.toHaveBeenCalled();
    expect(document.querySelector('[data-error]').textContent).toContain('不一致');

    form.elements.namedItem('confirmPassword').value = 'new-password';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(api.changePassword).toHaveBeenCalledWith({
      currentPassword: 'old-password',
      newPassword: 'new-password',
    }));
    expect(document.querySelector('.auth-backdrop')).toBeNull();
    expect(feedback.toast).toHaveBeenCalledWith('密码已修改', { type: 'success' });
  });

  it('submits a managed username as the login account without adding a domain', async () => {
    openAuthDialog();
    const form = document.querySelector('.auth-dialog');
    expect(document.querySelector('[data-account-label]').textContent).toBe('账号');
    form.elements.namedItem('account').value = 'alice';
    form.elements.namedItem('password').value = 'aliceabcde@graph.akusm.com';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(session.login).toHaveBeenCalledWith({
      account: 'alice',
      password: 'aliceabcde@graph.akusm.com',
    }));
  });
});
