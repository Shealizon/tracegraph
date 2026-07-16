import { FILE_ACCESS_MODES, normalizeFileAccessMode } from './fileAccess.js';

export function createExtensionTools(catalog, {
  serverApi,
  workspace,
  workspaceScope,
  projectId,
  fileAccessMode,
  confirmWrite,
} = {}) {
  const mode = normalizeFileAccessMode(fileAccessMode);
  const available = new Map((catalog?.tools || [])
    .filter((tool) => tool.ready !== false && (mode !== FILE_ACCESS_MODES.READ_ONLY || tool.readOnly))
    .map((tool) => [tool.name, tool]));
  const definitions = [...available.values()].map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));

  return {
    definitions,
    has: (name) => available.has(name),
    async execute(name, args) {
      if (!available.has(name)) throw new Error(`扩展工具不可用：${name}`);
      const tool = available.get(name);
      let writeApproved = !!tool.readOnly;
      if (!tool.readOnly && mode === FILE_ACCESS_MODES.ASK) {
        writeApproved = !!await confirmWrite?.({ name, args, description: tool.description });
        if (!writeApproved) return { executed: false, reason: '用户拒绝工具写入' };
      } else if (!tool.readOnly && mode === FILE_ACCESS_MODES.ALLOW) {
        writeApproved = true;
      }
      const response = await serverApi.executeExtensionTool(name, args, workspaceScope, projectId, writeApproved);
      for (const artifact of response.artifacts || []) {
        const full = (await serverApi.getFile(workspaceScope, artifact.path)).file;
        const bytes = Uint8Array.from(atob(full.data || ''), (character) => character.charCodeAt(0));
        await workspace.writeFile(artifact.path, new Blob([bytes], { type: full.type || 'application/octet-stream' }));
      }
      return { ...response.result, artifacts: response.artifacts || [] };
    },
  };
}
