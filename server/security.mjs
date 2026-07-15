import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const KEY_BYTES = 32;

export function randomId(prefix = '') {
  return `${prefix}${crypto.randomBytes(18).toString('base64url')}`;
}

export async function hashPassword(password, salt = crypto.randomBytes(16).toString('base64url')) {
  const key = await scrypt(String(password), salt, KEY_BYTES);
  return { salt, hash: Buffer.from(key).toString('base64url') };
}

export async function verifyPassword(password, record) {
  if (!record?.salt || !record?.hash) return false;
  const candidate = await hashPassword(password, record.salt);
  const a = Buffer.from(candidate.hash, 'base64url');
  const b = Buffer.from(record.hash, 'base64url');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function wrapWorkspaceKey(workspaceKey, password, salt = crypto.randomBytes(16).toString('base64url')) {
  const wrappingKey = await scrypt(String(password), salt, KEY_BYTES);
  return { salt, ...encryptBuffer(workspaceKey, Buffer.from(wrappingKey)) };
}

export async function unwrapWorkspaceKey(record, password) {
  const wrappingKey = await scrypt(String(password), record.salt, KEY_BYTES);
  return decryptBuffer(record, Buffer.from(wrappingKey));
}

export function encryptJson(value, key) {
  return JSON.stringify(encryptBuffer(Buffer.from(JSON.stringify(value)), key));
}

export function decryptJson(payload, key) {
  const record = typeof payload === 'string' ? JSON.parse(payload) : payload;
  return JSON.parse(decryptBuffer(record, key).toString('utf8'));
}

export function encryptBuffer(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
  return {
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: encrypted.toString('base64url'),
  };
}

export function decryptBuffer(record, key) {
  if (record?.algorithm !== 'aes-256-gcm') throw new Error('Unsupported encrypted workspace format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(record.data, 'base64url')), decipher.final()]);
}
