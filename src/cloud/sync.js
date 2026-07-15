import { serverApi } from './api.js';
import {
  getDeletedProjects, listProjects, removeProjectFromSync, saveProjectFromSync,
  setProjectSyncHandler,
} from '../project/store.js';
import { isAuthenticated } from './session.js';

let db = null;
let running = null;
let timer = null;
let lastError = null;
let lastSyncedAt = '';
const listeners = new Set();

export function configureProjectSync(projectDb) {
  db = projectDb;
  setProjectSyncHandler(() => scheduleSync());
}

export function syncSnapshot() { return { syncing: !!running, lastError, lastSyncedAt }; }
export function onSyncChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }

export function scheduleSync(delay = 700) {
  if (!db || !isAuthenticated()) return;
  clearTimeout(timer);
  timer = setTimeout(() => syncNow().catch(() => {}), delay);
}

export async function syncNow() {
  if (!db || !isAuthenticated()) return null;
  if (running) return running;
  running = performSync();
  emit();
  try { return await running; }
  finally { running = null; emit(); }
}

async function performSync() {
  try {
    const localProjects = await listProjects(db);
    const result = await serverApi.sync(localProjects, getDeletedProjects());
    const remoteIds = new Set(result.projects.map((project) => project.id));
    for (const deletion of result.deleted || []) {
      const local = localProjects.find((project) => project.id === deletion.id);
      if (!local || time(deletion.deletedAt) >= time(local.updatedAt)) await removeProjectFromSync(db, deletion.id);
    }
    for (const project of result.projects) await saveProjectFromSync(db, project);
    for (const local of localProjects) {
      if (!remoteIds.has(local.id) && !(result.deleted || []).some((item) => item.id === local.id)) {
        await saveProjectFromSync(db, { ...local, sync: { state: 'synced', location: 'cloud', syncedAt: result.syncedAt } });
      }
    }
    lastSyncedAt = result.syncedAt;
    lastError = null;
    return result;
  } catch (error) {
    lastError = error;
    throw error;
  }
}

function emit() { const state = syncSnapshot(); for (const listener of listeners) listener(state); }
function time(value) { const result = Date.parse(value || 0); return Number.isFinite(result) ? result : 0; }
