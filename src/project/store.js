import rawDemoGraph from '../data/paper-graph.json';
import { createDemoProject, normalizeProject, PROJECT_FORMAT } from './projectAdapter.js';

const DB_NAME = 'paper-graph-projects';
const DB_VERSION = 1;
const STORE = 'projects';
const CURRENT_KEY = 'paper-graph-current-project';

export async function initProjectStore() {
  const db = await openDb();
  const projects = await listProjects(db);
  if (!projects.length) {
    const demo = createDemoProject(rawDemoGraph);
    await saveProject(db, demo);
    localStorage.setItem(CURRENT_KEY, demo.id);
    return { db, projects: [demo], currentProjectId: demo.id };
  }
  let currentProjectId = localStorage.getItem(CURRENT_KEY);
  if (!projects.some((p) => p.id === currentProjectId)) {
    currentProjectId = projects[0].id;
    localStorage.setItem(CURRENT_KEY, currentProjectId);
  }
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
  return txRequest(db, 'readonly', (store) => store.getAll()).then((items) => items.map(normalizeProject));
}

export function getProject(db, id) {
  return txRequest(db, 'readonly', (store) => store.get(id)).then((p) => p ? normalizeProject(p) : null);
}

export function saveProject(db, project) {
  const normalized = normalizeProject({ ...project, updatedAt: new Date().toISOString() });
  return txRequest(db, 'readwrite', (store) => store.put(normalized)).then(() => normalized);
}

export function deleteProject(db, id) {
  return txRequest(db, 'readwrite', (store) => store.delete(id));
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
