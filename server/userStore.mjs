import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  decryptJson, encryptJson, hashPassword, randomId, unwrapWorkspaceKey,
  verifyPassword, wrapWorkspaceKey,
} from './security.mjs';

const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;

export class UserStore {
  constructor(dataRoot) {
    this.dataRoot = path.resolve(dataRoot);
    this.usersRoot = path.join(this.dataRoot, 'users');
    this.registryPath = path.join(this.dataRoot, 'users.json');
    this.sessions = new Map();
    this.locks = new Map();
  }

  async init() {
    await fs.mkdir(this.usersRoot, { recursive: true });
    try { await fs.access(this.registryPath); }
    catch { await this.writeRegistry({ version: 1, users: [] }); }
    const registry = await this.readRegistry();
    if (!registry.users.length && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
      await this.register({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD, name: process.env.ADMIN_NAME || 'Administrator' });
    }
  }

  async register({ email, password, name }) {
    const normalizedEmail = normalizeEmail(email);
    validatePassword(password);
    return this.withLock('registry', async () => {
      const registry = await this.readRegistry();
      if (registry.users.some((user) => user.email === normalizedEmail)) throw httpError(409, '该邮箱已注册');
      const now = new Date().toISOString();
      const id = randomId('usr_');
      const workspaceKey = crypto.randomBytes(32);
      const passwordRecord = await hashPassword(password);
      const keyRecord = await wrapWorkspaceKey(workspaceKey, password);
      const user = {
        id,
        email: normalizedEmail,
        name: String(name || normalizedEmail.split('@')[0]).trim().slice(0, 64),
        role: registry.users.length ? 'user' : 'admin',
        status: 'active',
        password: passwordRecord,
        createdAt: now,
        lastLoginAt: '',
      };
      const dir = this.userDir(id);
      await fs.mkdir(path.join(dir, 'files'), { recursive: true });
      await fs.writeFile(path.join(dir, 'key.json'), JSON.stringify(keyRecord, null, 2), { mode: 0o600 });
      await fs.writeFile(path.join(dir, 'vault.enc'), encryptJson(emptyVault(now), workspaceKey), { mode: 0o600 });
      registry.users.push(user);
      await this.writeRegistry(registry);
      return this.publicUser(user);
    });
  }

  async login({ email, password }) {
    const normalizedEmail = normalizeEmail(email);
    return this.withLock('registry', async () => {
      const registry = await this.readRegistry();
      const user = registry.users.find((item) => item.email === normalizedEmail);
      if (!user || !await verifyPassword(password, user.password)) throw httpError(401, '邮箱或密码错误');
      if (user.status !== 'active') throw httpError(403, '账号已停用');
      const keyRecord = JSON.parse(await fs.readFile(path.join(this.userDir(user.id), 'key.json'), 'utf8'));
      let workspaceKey;
      try { workspaceKey = await unwrapWorkspaceKey(keyRecord, password); }
      catch { throw httpError(401, '邮箱或密码错误'); }
      user.lastLoginAt = new Date().toISOString();
      await this.writeRegistry(registry);
      const token = randomId('ses_');
      this.sessions.set(token, { token, userId: user.id, workspaceKey, expiresAt: Date.now() + SESSION_TTL });
      return { token, user: this.publicUser(user) };
    });
  }

  logout(token) { if (token) this.sessions.delete(token); }

  async authenticate(token) {
    const session = this.sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      if (token) this.sessions.delete(token);
      throw httpError(401, '请先登录');
    }
    const registry = await this.readRegistry();
    const user = registry.users.find((item) => item.id === session.userId);
    if (!user || user.status !== 'active') throw httpError(401, '登录已失效');
    session.expiresAt = Date.now() + SESSION_TTL;
    return { session, user: this.publicUser(user) };
  }

  async readVault(session) {
    const encrypted = await fs.readFile(path.join(this.userDir(session.userId), 'vault.enc'), 'utf8');
    return decryptJson(encrypted, session.workspaceKey);
  }

  async updateVault(session, update) {
    return this.withLock(`vault:${session.userId}`, async () => {
      const vault = await this.readVault(session);
      const next = await update(vault) || vault;
      next.updatedAt = new Date().toISOString();
      const target = path.join(this.userDir(session.userId), 'vault.enc');
      const tmp = `${target}.${randomId('tmp_')}`;
      await fs.writeFile(tmp, encryptJson(next, session.workspaceKey), { mode: 0o600 });
      await replaceFile(tmp, target);
      return next;
    });
  }

  async listUsers(requester) {
    if (requester.role !== 'admin') throw httpError(403, '需要管理员权限');
    const registry = await this.readRegistry();
    return registry.users.map((user) => this.publicUser(user));
  }

  async updateUser(requester, userId, patch) {
    if (requester.role !== 'admin') throw httpError(403, '需要管理员权限');
    return this.withLock('registry', async () => {
      const registry = await this.readRegistry();
      const user = registry.users.find((item) => item.id === userId);
      if (!user) throw httpError(404, '用户不存在');
      if (patch.status && ['active', 'suspended'].includes(patch.status)) user.status = patch.status;
      if (patch.role && ['admin', 'user'].includes(patch.role)) user.role = patch.role;
      await this.writeRegistry(registry);
      return this.publicUser(user);
    });
  }

  publicUser(user) {
    return {
      id: user.id, email: user.email, name: user.name, role: user.role, status: user.status,
      createdAt: user.createdAt, lastLoginAt: user.lastLoginAt,
    };
  }

  userDir(userId) { return path.join(this.usersRoot, userId); }
  async readRegistry() { return JSON.parse(await fs.readFile(this.registryPath, 'utf8')); }
  async writeRegistry(value) {
    await fs.mkdir(this.dataRoot, { recursive: true });
    const tmp = `${this.registryPath}.${randomId('tmp_')}`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await replaceFile(tmp, this.registryPath);
  }

  withLock(key, operation) {
    const previous = this.locks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    const tracked = current.catch(() => {}).finally(() => { if (this.locks.get(key) === tracked) this.locks.delete(key); });
    this.locks.set(key, tracked);
    return current;
  }
}

function emptyVault(now) {
  return { version: 1, createdAt: now, updatedAt: now, projects: {}, deletedProjects: {}, providers: {}, tasks: {}, state: {}, files: {} };
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, '请输入有效邮箱');
  return email;
}

function validatePassword(value) {
  const password = String(value || '');
  if (password.length < 8 || password.length > 200) throw httpError(400, '密码长度需为 8–200 位');
}

export function httpError(status, message) { return Object.assign(new Error(message), { status }); }

async function replaceFile(source, target) {
  try { await fs.rename(source, target); }
  catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
    await fs.copyFile(source, target);
    await fs.rm(source, { force: true });
  }
}
