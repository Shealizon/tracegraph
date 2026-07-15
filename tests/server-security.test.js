import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { decryptJson, encryptJson, unwrapWorkspaceKey, wrapWorkspaceKey } from '../server/security.mjs';

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
});
