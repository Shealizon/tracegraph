import { debugCheckpoint } from '../debug/diagnostics.js';

const ROOT_DIR = 'paper-graph-ai';

export function browserWorkspaceScope(value) {
  return safeSegment(value || 'default');
}

export function normalizeWorkspacePath(value) {
  const path = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = path.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..' || part.includes('\0'))) {
    throw new Error('无效的工作区路径');
  }
  return parts.join('/');
}

export function createBrowserWorkspace(projectId) {
  const scope = browserWorkspaceScope(projectId);

  async function clear() {
    if (!navigator.storage?.getDirectory) return;
    const opfs = await navigator.storage.getDirectory();
    const appRoot = await opfs.getDirectoryHandle(ROOT_DIR, { create: true });
    try { await appRoot.removeEntry(scope, { recursive: true }); }
    catch (error) { if (error?.name !== 'NotFoundError') throw error; }
    debugCheckpoint('src/ai/workspace.js', 'workspace-cleared', { scope });
  }

  async function root() {
    if (!navigator.storage?.getDirectory) {
      throw new Error('当前浏览器不支持 OPFS，请使用较新的浏览器并通过 HTTPS 或 localhost 打开。');
    }
    const opfs = await navigator.storage.getDirectory();
    const appRoot = await opfs.getDirectoryHandle(ROOT_DIR, { create: true });
    return appRoot.getDirectoryHandle(scope, { create: true });
  }

  async function resolveFile(path, { create = false } = {}) {
    const parts = normalizeWorkspacePath(path).split('/');
    const fileName = parts.pop();
    let dir = await root();
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
    return dir.getFileHandle(fileName, { create });
  }

  async function writeFile(path, data) {
    const handle = await resolveFile(path, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(data);
    } finally {
      await writable.close();
    }
    debugCheckpoint('src/ai/workspace.js', 'file-written', {
      scope,
      path: normalizeWorkspacePath(path),
      size: data?.size ?? data?.byteLength ?? String(data || '').length,
    });
    return normalizeWorkspacePath(path);
  }

  async function readFile(path) {
    const handle = await resolveFile(path);
    const file = await handle.getFile();
    debugCheckpoint('src/ai/workspace.js', 'file-read', { scope, path: normalizeWorkspacePath(path), size: file.size });
    return file;
  }

  async function deleteFile(path) {
    const parts = normalizeWorkspacePath(path).split('/');
    const fileName = parts.pop();
    let dir = await root();
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    try { await dir.removeEntry(fileName); }
    catch (error) { if (error?.name !== 'NotFoundError') throw error; }
    debugCheckpoint('src/ai/workspace.js', 'file-deleted', { scope, path: normalizeWorkspacePath(path) });
    return normalizeWorkspacePath(path);
  }

  async function listFiles() {
    const items = [];
    await walk(await root(), '', items);
    debugCheckpoint('src/ai/workspace.js', 'files-listed', { scope, count: items.length });
    return items.sort((a, b) => a.path.localeCompare(b.path));
  }

  async function importFile(file) {
    const path = await uniquePath(`uploads/${safeFileName(file.name || 'file')}`);
    await writeFile(path, file);
    return { path, name: file.name, size: file.size, type: file.type || guessType(file.name) };
  }

  async function uniquePath(preferred) {
    const normalized = normalizeWorkspacePath(preferred);
    const files = new Set((await listFiles()).map((item) => item.path));
    if (!files.has(normalized)) return normalized;
    const dot = normalized.lastIndexOf('.');
    const base = dot > normalized.lastIndexOf('/') ? normalized.slice(0, dot) : normalized;
    const ext = base === normalized ? '' : normalized.slice(dot);
    let i = 2;
    while (files.has(`${base}-${i}${ext}`)) i += 1;
    return `${base}-${i}${ext}`;
  }

  return { clear, deleteFile, importFile, listFiles, readFile, writeFile };
}

export async function exportBrowserWorkspaces({ scopePrefix = '' } = {}) {
  if (!navigator.storage?.getDirectory) return [];
  const opfs = await navigator.storage.getDirectory();
  let appRoot;
  try { appRoot = await opfs.getDirectoryHandle(ROOT_DIR); }
  catch (error) {
    if (error?.name === 'NotFoundError') return [];
    throw error;
  }
  const workspaces = [];
  debugCheckpoint('src/ai/workspace.js', 'workspace-export-start', { scopePrefix });
  for await (const [scope, handle] of appRoot.entries()) {
    if (handle.kind !== 'directory' || (scopePrefix && !scope.startsWith(scopePrefix))) continue;
    const files = [];
    await walkExportFiles(handle, '', files);
    workspaces.push({ scope, files: files.sort((a, b) => a.path.localeCompare(b.path)) });
  }
  const sorted = workspaces.sort((a, b) => a.scope.localeCompare(b.scope));
  debugCheckpoint('src/ai/workspace.js', 'workspace-export-complete', {
    scopePrefix,
    workspaceCount: sorted.length,
    fileCount: sorted.reduce((count, workspace) => count + workspace.files.length, 0),
  }, { level: 'info' });
  return sorted;
}

async function walk(dir, prefix, out) {
  for await (const [name, handle] of dir.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') await walk(handle, path, out);
    else {
      const file = await handle.getFile();
      out.push({ path, name, size: file.size, type: file.type || guessType(name), updatedAt: file.lastModified });
    }
  }
}

async function walkExportFiles(dir, prefix, out) {
  for await (const [name, handle] of dir.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') {
      await walkExportFiles(handle, path, out);
      continue;
    }
    const file = await handle.getFile();
    out.push({
      path,
      name,
      size: file.size,
      type: file.type || guessType(name),
      updatedAt: file.lastModified,
      encoding: 'base64',
      content: arrayBufferToBase64(await file.arrayBuffer()),
    });
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function safeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

function safeFileName(value) {
  return String(value).replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '').slice(0, 140) || 'file';
}

function guessType(name) {
  const lower = String(name).toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.png')) return 'image/png';
  if (/\.jpe?g$/i.test(lower)) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.avif')) return 'image/avif';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (/\.(md|txt|tex|csv|js|ts|css|html)$/i.test(lower)) return 'text/plain';
  return 'application/octet-stream';
}
