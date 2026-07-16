import { exportBrowserWorkspaces, browserWorkspaceScope } from '../ai/workspace.js';
import { listProjects } from '../project/store.js';
import { debugCheckpoint, debugError } from './diagnostics.js';

export const CONVERSATION_EXPORT_FORMAT = 'entail-conversation@1';
export const PROJECT_DATA_EXPORT_FORMAT = 'entail-project-data@1';
export const APPLICATION_DATA_EXPORT_FORMAT = 'entail-application-data@1';

export function buildConversationExport(conversation, {
  projectId = '',
  projectName = '',
  exportedAt = new Date().toISOString(),
} = {}) {
  if (!conversation || typeof conversation !== 'object') throw new Error('无效的对话数据');
  return {
    format: CONVERSATION_EXPORT_FORMAT,
    exportedAt,
    project: { id: projectId, name: projectName },
    conversation: cloneJson(conversation),
  };
}

export function downloadConversationData(conversation, options = {}) {
  try {
    const payload = buildConversationExport(conversation, options);
    const name = safeFilename(conversation.title || conversation.id || 'conversation');
    downloadJsonFile(payload, `${name}.entail-conversation.json`);
    debugCheckpoint('src/debug/exportData.js', 'conversation-exported', {
      conversationId: conversation.id,
      messageCount: conversation.messages?.length || 0,
    }, { level: 'info' });
    return payload;
  } catch (error) {
    debugError('src/debug/exportData.js', 'conversation-export-failed', error, { conversationId: conversation?.id });
    throw error;
  }
}

export async function buildProjectDataExport(project, {
  storage = globalThis.localStorage,
  workspaceExporter = exportBrowserWorkspaces,
  exportedAt = new Date().toISOString(),
} = {}) {
  if (!project || typeof project !== 'object') throw new Error('无效的项目数据');
  const scopePrefix = `${browserWorkspaceScope(project.id)}--`;
  const workspaces = await workspaceExporter({ scopePrefix });
  return {
    format: PROJECT_DATA_EXPORT_FORMAT,
    exportedAt,
    project: cloneJson(project),
    ai: {
      conversations: readJsonStorage(storage, `paper-graph-ai-conversations:${project.id}`),
      legacyHistory: readJsonStorage(storage, `paper-graph-ai-history:${project.id}`),
      workspaces,
    },
    browserLocalStorage: snapshotStorage(storage),
  };
}

export async function downloadProjectData(project, options = {}) {
  try {
    const payload = await buildProjectDataExport(project, options);
    const name = safeFilename(project.name || project.id || 'project');
    downloadJsonFile(payload, `${name}.entail-project-data.json`);
    debugCheckpoint('src/debug/exportData.js', 'project-data-exported', {
      projectId: project.id,
      workspaceCount: payload.ai.workspaces.length,
    }, { level: 'info' });
    return payload;
  } catch (error) {
    debugError('src/debug/exportData.js', 'project-data-export-failed', error, { projectId: project?.id });
    throw error;
  }
}

export async function buildApplicationDataExport(db, {
  storage = globalThis.localStorage,
  workspaceExporter = exportBrowserWorkspaces,
  projectLoader = listProjects,
  exportedAt = new Date().toISOString(),
} = {}) {
  const [projects, workspaces] = await Promise.all([
    projectLoader(db),
    workspaceExporter(),
  ]);
  return {
    format: APPLICATION_DATA_EXPORT_FORMAT,
    exportedAt,
    projects: cloneJson(projects),
    ai: {
      conversationsByProject: Object.fromEntries(projects.map((project) => [
        project.id,
        readJsonStorage(storage, `paper-graph-ai-conversations:${project.id}`),
      ])),
      workspaces,
    },
    browserLocalStorage: snapshotStorage(storage),
  };
}

export async function downloadApplicationData(db, options = {}) {
  try {
    const payload = await buildApplicationDataExport(db, options);
    downloadJsonFile(payload, `entail-all-data-${filenameTimestamp(payload.exportedAt)}.json`);
    debugCheckpoint('src/debug/exportData.js', 'application-data-exported', {
      projectCount: payload.projects.length,
      workspaceCount: payload.ai.workspaces.length,
    }, { level: 'info' });
    return payload;
  } catch (error) {
    debugError('src/debug/exportData.js', 'application-data-export-failed', error);
    throw error;
  }
}

export function snapshotStorage(storage) {
  if (!storage) return {};
  const entries = {};
  for (let index = 0; index < Number(storage.length || 0); index += 1) {
    const key = storage.key(index);
    if (key != null) entries[key] = storage.getItem(key);
  }
  return entries;
}

export function downloadJsonFile(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const anchor = document.createElement('a');
  const url = URL.createObjectURL(blob);
  anchor.href = url;
  anchor.download = safeFilename(filename);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(value) {
  return String(value || 'export').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'export';
}

function readJsonStorage(storage, key) {
  try { return JSON.parse(storage?.getItem(key) || 'null'); }
  catch { return null; }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function filenameTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown-time';
  return date.toISOString().replace(/[:.]/g, '-');
}
