import rawDemoGraph from '../data/tracegraph.json';
import { createDemoProject, normalizeProject, PROJECT_FORMAT } from './projectAdapter.js';
import { debugCheckpoint } from '../debug/diagnostics.js';

const DB_NAME = 'tracegraph-projects';
const DB_VERSION = 1;
const STORE = 'projects';
const CURRENT_KEY = 'tracegraph-current-project';
const DELETED_KEY = 'tracegraph-deleted-projects';
let syncHandler = null;

export async function initProjectStore() {
  debugCheckpoint('src/project/store.js', 'init-start');
  const db = await openDb();
  const projects = await listProjects(db);
  if (!projects.length) {
    const demo = createDemoProject(rawDemoGraph);
    await saveProject(db, demo);
    localStorage.setItem(CURRENT_KEY, demo.id);
    debugCheckpoint('src/project/store.js', 'demo-created', { projectId: demo.id });
    return { db, projects: [demo], currentProjectId: demo.id };
  }
  let currentProjectId = localStorage.getItem(CURRENT_KEY);
  if (!projects.some((p) => p.id === currentProjectId)) {
    currentProjectId = projects[0].id;
    localStorage.setItem(CURRENT_KEY, currentProjectId);
  }
  debugCheckpoint('src/project/store.js', 'init-complete', { projectCount: projects.length, currentProjectId });
  return { db, projects, currentProjectId };
}

export function setCurrentProjectId(id) {
  localStorage.setItem(CURRENT_KEY, id);
}

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function listProjects(db) {
  return txRequest(db, 'readonly', (store) => store.getAll()).then((items) => {
    const projects = items.map(normalizeProject);
    debugCheckpoint('src/project/store.js', 'projects-listed', { count: projects.length });
    return projects;
  });
}

export function getProject(db, id) {
  return txRequest(db, 'readonly', (store) => store.get(id)).then((p) => p ? normalizeProject(p) : null);
}

export function saveProject(db, project) {
  const normalized = normalizeProject({
    ...project,
    updatedAt: new Date().toISOString(),
    sync: { ...(project.sync || {}), state: 'local', location: project.sync?.location || 'local' },
  });
  return txRequest(db, 'readwrite', (store) => store.put(normalized)).then(() => {
    clearDeletedProject(normalized.id);
    syncHandler?.({ type: 'save', id: normalized.id });
    debugCheckpoint('src/project/store.js', 'project-saved', {
      projectId: normalized.id,
      documentCount: normalized.documents?.length || 0,
    });
    return normalized;
  });
}

export function deleteProject(db, id) {
  return txRequest(db, 'readwrite', (store) => store.delete(id)).then(() => {
    recordDeletedProject(id);
    syncHandler?.({ type: 'delete', id });
    debugCheckpoint('src/project/store.js', 'project-deleted', { projectId: id });
  });
}

export function setProjectSyncHandler(handler) { syncHandler = typeof handler === 'function' ? handler : null; }

export function getDeletedProjects() {
  try { return JSON.parse(localStorage.getItem(DELETED_KEY) || '[]'); } catch { return []; }
}

export function saveProjectFromSync(db, project) {
  const normalized = normalizeProject({ ...project, sync: { state: 'synced', location: 'cloud', syncedAt: project.sync?.syncedAt || new Date().toISOString() } });
  return txRequest(db, 'readwrite', (store) => store.put(normalized)).then(() => { clearDeletedProject(normalized.id); return normalized; });
}

export function removeProjectFromSync(db, id) {
  return txRequest(db, 'readwrite', (store) => store.delete(id)).then(() => clearDeletedProject(id));
}

export function isProjectPayload(value) {
  return value?.format === PROJECT_FORMAT || Array.isArray(value?.documents);
}

function txRequest(db, mode, makeRequest) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = makeRequest(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.onerror = () => reject(tx.error);
  });
}

function recordDeletedProject(id) {
  const items = getDeletedProjects().filter((item) => item.id !== id);
  items.push({ id, deletedAt: new Date().toISOString() });
  localStorage.setItem(DELETED_KEY, JSON.stringify(items));
}

function clearDeletedProject(id) {
  const items = getDeletedProjects().filter((item) => item.id !== id);
  localStorage.setItem(DELETED_KEY, JSON.stringify(items));
}
