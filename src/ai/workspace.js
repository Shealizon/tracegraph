const ROOT_DIR = 'paper-graph-ai';

export function normalizeWorkspacePath(value) {
  const path = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = path.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..' || part.includes('\0'))) {
    throw new Error('无效的工作区路径');
  }
  return parts.join('/');
}

export function createBrowserWorkspace(projectId) {
  const scope = safeSegment(projectId || 'default');

  async function clear() {
    if (!navigator.storage?.getDirectory) return;
    const opfs = await navigator.storage.getDirectory();
    const appRoot = await opfs.getDirectoryHandle(ROOT_DIR, { create: true });
    try { await appRoot.removeEntry(scope, { recursive: true }); }
    catch (error) { if (error?.name !== 'NotFoundError') throw error; }
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
    return normalizeWorkspacePath(path);
  }

  async function readFile(path) {
    const handle = await resolveFile(path);
    return handle.getFile();
  }

  async function deleteFile(path) {
    const parts = normalizeWorkspacePath(path).split('/');
    const fileName = parts.pop();
    let dir = await root();
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    try { await dir.removeEntry(fileName); }
    catch (error) { if (error?.name !== 'NotFoundError') throw error; }
    return normalizeWorkspacePath(path);
  }

  async function listFiles() {
    const items = [];
    await walk(await root(), '', items);
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
