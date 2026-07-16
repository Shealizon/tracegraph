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
});
