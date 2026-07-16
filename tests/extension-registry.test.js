import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExtensionRegistry, persistArtifacts } from '../server/extensionRegistry.mjs';
import { createServerTools } from '../server/taskRunner.mjs';
import { createExtensionTools } from '../src/ai/extensionTools.js';

const roots = [];

afterEach(async () => {
  delete process.env.PAPER_GRAPH_TEST_SECRET;
  delete process.env.PAPER_GRAPH_PYTHON;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('paper graph extension registry', () => {
  it('installs declared dependencies in an isolated venv and exposes skills and tools', async () => {
    const root = await temporaryRoot();
    const calls = [];
    const run = vi.fn(async (command, args) => {
      calls.push([command, args]);
      return { stdout: 'ok', stderr: '' };
    });
    const registry = new ExtensionRegistry(root, {
      python: { command: 'python-test', prefix: [] },
      spawnCapture: run,
    });
    await registry.init();
    const installed = await registry.install(exampleBundle(), { actor: 'admin-id' });

    expect(installed).toMatchObject({
      id: 'example-tools',
      version: '1.0.0',
      ready: true,
      skills: [{ id: 'example-reader' }],
      tools: [{ name: 'example_read' }],
    });
    expect(calls.some(([, args]) => args.includes('venv'))).toBe(true);
    expect(calls.some(([, args]) => args.includes('demo-lib>=1,<2'))).toBe(true);
    expect(registry.definitions()[0].function.name).toBe('example_read');
    expect(registry.skillPrompt()).toContain('Only read files from the workspace');
    expect(JSON.parse(await fs.readFile(path.join(root, 'registry.json'), 'utf8')).packages['example-tools']).toBeTruthy();
  });

  it('runs an installed tool against a temporary workspace and collects declared artifacts', async () => {
    const root = await temporaryRoot();
    process.env.PAPER_GRAPH_TEST_SECRET = 'must-not-leak';
    const run = vi.fn(async (_command, _args, options = {}) => {
      if (!options.env?.PAPER_GRAPH_OUTPUT) return { stdout: 'ok', stderr: '' };
      expect(options.env.PAPER_GRAPH_TEST_SECRET).toBeUndefined();
      const input = JSON.parse(options.input);
      const workspaceText = await fs.readFile(path.join(options.env.PAPER_GRAPH_WORKSPACE, 'notes', 'input.txt'), 'utf8');
      await fs.writeFile(path.join(options.env.PAPER_GRAPH_OUTPUT, 'result.txt'), `${input.args.prefix}:${workspaceText}`);
      return {
        stdout: JSON.stringify({
          message: 'created',
          artifacts: [{ path: 'result.txt', workspacePath: 'generated/result.txt', type: 'text/plain' }],
        }),
        stderr: '',
      };
    });
    const registry = new ExtensionRegistry(root, {
      python: { command: 'python-test', prefix: [] },
      spawnCapture: run,
    });
    await registry.init();
    await registry.install(exampleBundle());

    await expect(registry.execute('example_read', { unexpected: true })).rejects.toThrow('不是允许的参数');

    const execution = await registry.execute('example_read', { prefix: 'done' }, {
      workspaceFiles: [{
        path: 'notes/input.txt',
        data: Buffer.from('content').toString('base64'),
      }],
      workspaceScope: 'scope',
      projectId: 'project',
    });
    expect(execution.result).toEqual({ message: 'created' });
    expect(execution.artifacts).toHaveLength(1);
    expect(Buffer.from(execution.artifacts[0].data, 'base64').toString()).toBe('done:content');
    expect(execution.artifacts[0].path).toBe('generated/result.txt');

    const vault = { files: {} };
    const userStore = { updateVault: vi.fn(async (_session, update) => update(vault)) };
    await persistArtifacts(userStore, {}, 'scope', execution);
    expect(vault.files['scope::generated/result.txt']).toMatchObject({
      scope: 'scope',
      path: 'generated/result.txt',
      type: 'text/plain',
    });
  });

  it('rejects unsafe dependencies, traversal paths, and reserved tool names', async () => {
    const root = await temporaryRoot();
    const registry = new ExtensionRegistry(root, {
      python: { command: 'python-test', prefix: [] },
      spawnCapture: vi.fn(async () => ({ stdout: 'ok', stderr: '' })),
    });
    await registry.init();
    const unsafeDependency = exampleBundle();
    unsafeDependency.manifest.dependencies.python = ['https://evil.example/pkg.whl'];
    await expect(registry.install(unsafeDependency)).rejects.toThrow('不允许的 Python 依赖');

    const traversal = exampleBundle();
    traversal.files[0].path = '../skill.md';
    await expect(registry.install(traversal)).rejects.toThrow('无效扩展文件路径');

    const reserved = exampleBundle();
    reserved.manifest.tools[0].name = 'read_file';
    await expect(registry.install(reserved)).rejects.toThrow('系统工具冲突');
  });

  it('selects Python 3.9+ and keeps the service available when a built-in install fails', async () => {
    const root = await temporaryRoot();
    const builtinsRoot = await temporaryRoot();
    const builtinDir = path.join(builtinsRoot, 'example-tools');
    const bundle = exampleBundle();
    await fs.mkdir(path.join(builtinDir, 'skills'), { recursive: true });
    await fs.mkdir(path.join(builtinDir, 'tools'), { recursive: true });
    await fs.writeFile(path.join(builtinDir, 'manifest.json'), JSON.stringify(bundle.manifest));
    for (const file of bundle.files) {
      await fs.writeFile(path.join(builtinDir, file.path), file.data);
    }
    process.env.PAPER_GRAPH_PYTHON = 'legacy-python';
    const calls = [];
    const run = vi.fn(async (command, args) => {
      calls.push([command, args]);
      if (args.includes('--version')) {
        if (command === 'legacy-python') return { stdout: 'Python 3.6.8', stderr: '' };
        if (command === 'python3.12') throw new Error('not installed');
        if (command === 'python3.11') return { stdout: 'Python 3.11.13', stderr: '' };
      }
      if (args.includes('pip')) throw new Error('package mirror unavailable');
      return { stdout: '', stderr: '' };
    });
    const registry = new ExtensionRegistry(root, { builtinsRoot, spawnCapture: run });

    await expect(registry.init()).resolves.toBeUndefined();
    expect(calls.some(([command, args]) => command === 'python3.11' && args.includes('venv'))).toBe(true);
    expect(registry.list()).toMatchObject({
      packages: [],
      failures: [{ id: 'example-tools', error: 'package mirror unavailable' }],
    });
  });

  it('adds extension definitions to server model tool loops', async () => {
    const extensions = {
      definitions: () => [{
        type: 'function',
        function: { name: 'example_read', description: 'read', parameters: { type: 'object', properties: {} } },
      }],
      findTool: (name) => name === 'example_read',
      execute: vi.fn(async () => ({ result: { value: 42 }, artifacts: [], tool: { name: 'example_read' } })),
    };
    const tools = createServerTools({ projects: {}, files: {} }, '', 'scope', { extensions });
    expect(tools.definitions.map((item) => item.function.name)).toContain('example_read');
    await expect(tools.execute('example_read', {})).resolves.toEqual({ value: 42, artifacts: [] });
  });
});

describe('browser extension tools', () => {
  it('includes ready tools and synchronizes generated artifacts into OPFS', async () => {
    const workspace = { writeFile: vi.fn(async () => {}) };
    const serverApi = {
      executeExtensionTool: vi.fn(async () => ({
        result: { pages: 2 },
        artifacts: [{ path: 'generated/result.pdf', type: 'application/pdf' }],
      })),
      getFile: vi.fn(async () => ({
        file: {
          path: 'generated/result.pdf',
          type: 'application/pdf',
          data: btoa('pdf-data'),
        },
      })),
    };
    const tools = createExtensionTools({
      tools: [
        { name: 'pdf_merge', description: 'merge', inputSchema: { type: 'object' }, ready: true },
        { name: 'paddle_ocr', description: 'ocr', inputSchema: { type: 'object' }, ready: false },
      ],
    }, { serverApi, workspace, workspaceScope: 'scope', projectId: 'project' });

    expect(tools.definitions.map((item) => item.function.name)).toEqual(['pdf_merge']);
    await expect(tools.execute('pdf_merge', { files: [] })).resolves.toMatchObject({ pages: 2 });
    expect(serverApi.executeExtensionTool).toHaveBeenCalledWith('pdf_merge', { files: [] }, 'scope', 'project');
    expect(workspace.writeFile).toHaveBeenCalledWith('generated/result.pdf', expect.any(Blob));
  });
});

async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-graph-extension-test-'));
  roots.push(root);
  return root;
}

function exampleBundle() {
  return {
    format: 'paper-graph-extension@1',
    manifest: {
      id: 'example-tools',
      name: 'Example Tools',
      version: '1.0.0',
      description: 'Example extension package',
      dependencies: { python: ['demo-lib>=1,<2'] },
      skills: [{
        id: 'example-reader',
        name: 'Example Reader',
        description: 'Read example files',
        file: 'skills/example.md',
      }],
      tools: [{
        name: 'example_read',
        action: 'read',
        description: 'Read one example file',
        inputSchema: {
          type: 'object',
          properties: { prefix: { type: 'string' } },
          additionalProperties: false,
        },
        entry: 'tools/example.py',
      }],
    },
    files: [
      { path: 'skills/example.md', encoding: 'utf8', data: 'Only read files from the workspace.' },
      { path: 'tools/example.py', encoding: 'utf8', data: 'print("example")' },
    ],
  };
}
