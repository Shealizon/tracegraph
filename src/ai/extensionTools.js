export function createExtensionTools(catalog, {
  serverApi,
  workspace,
  workspaceScope,
  projectId,
} = {}) {
  const available = new Map((catalog?.tools || []).filter((tool) => tool.ready !== false).map((tool) => [tool.name, tool]));
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
      const response = await serverApi.executeExtensionTool(name, args, workspaceScope, projectId);
      for (const artifact of response.artifacts || []) {
        const full = (await serverApi.getFile(workspaceScope, artifact.path)).file;
        const bytes = Uint8Array.from(atob(full.data || ''), (character) => character.charCodeAt(0));
        await workspace.writeFile(artifact.path, new Blob([bytes], { type: full.type || 'application/octet-stream' }));
      }
      return { ...response.result, artifacts: response.artifacts || [] };
    },
  };
}
