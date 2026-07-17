import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decryptJson, encryptJson, unwrapWorkspaceKey, wrapWorkspaceKey } from '../server/security.mjs';
import { UserStore } from '../server/userStore.mjs';

describe('encrypted server workspaces', () => {
  it('wraps the workspace key with the user password and encrypts vault data', async () => {
    const workspaceKey = crypto.randomBytes(32);
    const wrapped = await wrapWorkspaceKey(workspaceKey, 'correct horse battery staple');
    const unwrapped = await unwrapWorkspaceKey(wrapped, 'correct horse battery staple');
    expect(unwrapped.equals(workspaceKey)).toBe(true);

    const encrypted = encryptJson({ apiKey: 'secret-value', projects: ['p1'] }, unwrapped);
    expect(encrypted).not.toContain('secret-value');
    expect(decryptJson(encrypted, workspaceKey)).toEqual({ apiKey: 'secret-value', projects: ['p1'] });
  });

  it('does not unlock a workspace with the wrong password', async () => {
    const wrapped = await wrapWorkspaceKey(crypto.randomBytes(32), 'right-password');
    await expect(unwrapWorkspaceKey(wrapped, 'wrong-password')).rejects.toThrow();
  });

  it('keeps encrypted login sessions valid across server restarts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-graph-session-'));
    try {
      const first = new UserStore(root);
      await first.init();
      await first.register({ email: 'admin@example.com', password: 'correct-password', name: 'Admin' });
      const login = await first.login({ email: 'admin@example.com', password: 'correct-password' });

      const restarted = new UserStore(root);
      await restarted.init();
      const authenticated = await restarted.authenticate(login.token);
      expect(authenticated.user).toMatchObject({ email: 'admin@example.com', role: 'admin' });
      expect(await restarted.readVault(authenticated.session)).toMatchObject({ version: 1, projects: {} });

      await restarted.logout(login.token);
      const afterLogout = new UserStore(root);
      await afterLogout.init();
      await expect(afterLogout.authenticate(login.token)).rejects.toThrow('请先登录');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 10_000);

  it('lets an administrator create a managed user with a one-time generated password', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-graph-managed-user-'));
    try {
      const store = new UserStore(root);
      await store.init();
      const admin = await store.register({ email: 'admin@example.com', password: 'admin-password', name: 'Admin' });
      const created = await store.createUser(admin, { username: 'Alice' });

      expect(created.user).toMatchObject({
        username: 'alice',
        email: 'alice@graph.akusm.com',
        name: 'alice',
        role: 'user',
      });
      expect(created.initialPassword).toMatch(/^alice[a-z]{5}@graph\.akusm\.com$/);
      await expect(store.login({ account: 'alice', password: created.initialPassword }))
        .resolves.toMatchObject({ user: { id: created.user.id } });
      expect(await fs.readFile(path.join(root, 'users.json'), 'utf8')).not.toContain(created.initialPassword);
      await expect(store.createUser({ role: 'user' }, { username: 'blocked' })).rejects.toThrow('需要管理员权限');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 10_000);

  it('changes a user password without losing access to the encrypted workspace', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-graph-password-'));
    try {
      const store = new UserStore(root);
      await store.init();
      await store.register({ email: 'admin@example.com', password: 'old-password', name: 'Admin' });
      const login = await store.login({ email: 'admin@example.com', password: 'old-password' });
      const auth = await store.authenticate(login.token);
      await store.updateVault(auth.session, (vault) => { vault.state.passwordTest = 'preserved'; });

      await store.changePassword(auth, { currentPassword: 'old-password', newPassword: 'new-secure-password' });

      await expect(store.login({ email: 'admin@example.com', password: 'old-password' })).rejects.toThrow('账号或密码错误');
      const nextLogin = await store.login({ email: 'admin@example.com', password: 'new-secure-password' });
      const nextAuth = await store.authenticate(nextLogin.token);
      expect(await store.readVault(nextAuth.session)).toMatchObject({ state: { passwordTest: 'preserved' } });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 10_000);
});
