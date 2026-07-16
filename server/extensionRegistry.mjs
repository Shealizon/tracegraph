import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomId } from './security.mjs';
import { httpError } from './userStore.mjs';

const FORMAT = 'paper-graph-extension@1';
const REGISTRY_VERSION = 1;
const MAX_FILES = 120;
const MAX_PACKAGE_BYTES = 12 * 1024 * 1024;
const MAX_TOOL_OUTPUT = 2 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const INSTALL_TIMEOUT = 10 * 60_000;
const TOOL_TIMEOUT = 3 * 60_000;
const RESERVED_TOOL_NAMES = new Set([
  'get_project_summary', 'search_graph', 'get_graph_node',
  'list_workspace', 'read_file', 'read_pdf',
]);

export class ExtensionRegistry {
  constructor(root, options = {}) {
    this.root = path.resolve(root);
    this.packagesRoot = path.join(this.root, 'packages');
    this.dataRoot = path.join(this.root, 'data');
    this.registryPath = path.join(this.root, 'registry.json');
    this.builtinsRoot = options.builtinsRoot ? path.resolve(options.builtinsRoot) : '';
    this.spawnCapture = options.spawnCapture || spawnCapture;
    this.python = options.python || null;
    this.registry = { version: REGISTRY_VERSION, packages: {} };
    this.lock = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.packagesRoot, { recursive: true });
    await fs.mkdir(this.dataRoot, { recursive: true });
    try {
      this.registry = normalizeRegistry(JSON.parse(await fs.readFile(this.registryPath, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await this.save();
    }
    if (this.builtinsRoot) await this.installBuiltins();
  }

  async installBuiltins() {
    let entries = [];
    try { entries = await fs.readdir(this.builtinsRoot, { withFileTypes: true }); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const dir = path.join(this.builtinsRoot, entry.name);
      const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
      const current = this.registry.packages?.[manifest.id];
      if (current?.manifest?.version === manifest.version) continue;
      const bundle = await bundleFromDirectory(dir, manifest);
      await this.install(bundle, { actor: 'system', builtIn: true });
    }
  }

  list({ includeInstructions = false } = {}) {
    const packages = Object.values(this.registry.packages || {})
      .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
      .map((record) => publicPackage(record, includeInstructions));
    return {
      format: FORMAT,
      packages,
      skills: packages.flatMap((item) => item.skills),
      tools: packages.flatMap((item) => item.tools),
    };
  }

  getSkill(id) {
    for (const record of Object.values(this.registry.packages || {})) {
      const skill = record.manifest.skills.find((item) => item.id === id);
      if (skill) return { ...skill, packageId: record.manifest.id, packageName: record.manifest.name };
    }
    throw httpError(404, 'Skill 不存在');
  }

  definitions() {
    return Object.values(this.registry.packages || {}).flatMap((record) => {
      const ready = record.manifest.requiredEnv.every((key) => process.env[key]);
      return ready ? record.manifest.tools.map((tool) => toolDefinition(tool.name, tool.description, tool.inputSchema)) : [];
    });
  }

  dynamicTools() {
    return this.definitions().map((definition) => ({
      name: definition.function.name,
      description: definition.function.description,
      inputSchema: definition.function.parameters,
    }));
  }

  skillPrompt() {
    const skills = this.list({ includeInstructions: true }).packages
      .filter((item) => item.ready)
      .flatMap((item) => item.skills);
    if (!skills.length) return '';
    return [
      '服务器已安装以下 Paper Graph skills。根据任务选择最相关的 skill，并遵循其 instructions；不要声称使用未列出的 skill。',
      ...skills.map((skill) => [
        `<skill id="${skill.id}" package="${skill.packageId}">`,
        `name: ${skill.name}`,
        `description: ${skill.description}`,
        skill.instructions,
        '</skill>',
      ].join('\n')),
    ].join('\n\n');
  }

  async install(rawBundle, { actor = '', builtIn = false } = {}) {
    return this.withLock(async () => {
      const bundle = validateBundle(rawBundle);
      const { manifest } = bundle;
      for (const tool of manifest.tools) {
        if (RESERVED_TOOL_NAMES.has(tool.name)) throw httpError(409, `工具名与系统工具冲突：${tool.name}`);
        const existing = this.findTool(tool.name);
        if (existing && existing.record.manifest.id !== manifest.id) throw httpError(409, `工具名已由 ${existing.record.manifest.name} 使用：${tool.name}`);
      }
      for (const skill of manifest.skills) {
        const existing = Object.values(this.registry.packages || {}).find((record) =>
          record.manifest.id !== manifest.id && record.manifest.skills.some((item) => item.id === skill.id));
        if (existing) throw httpError(409, `Skill ID 已由 ${existing.manifest.name} 使用：${skill.id}`);
      }
      const stage = path.join(this.packagesRoot, `.staging-${manifest.id}-${randomId('')}`);
      const finalDir = path.join(this.packagesRoot, manifest.id);
      const backup = path.join(this.packagesRoot, `.backup-${manifest.id}-${randomId('')}`);
      await fs.mkdir(stage, { recursive: true });
      let movedOld = false;
      try {
        for (const file of bundle.files) {
          const target = safeJoin(stage, file.path);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, file.encoding === 'base64' ? Buffer.from(file.data, 'base64') : file.data);
        }
        await fs.writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
        const pythonInfo = manifest.tools.length ? await this.installPython(stage, manifest) : null;
        try {
          await fs.rename(finalDir, backup);
          movedOld = true;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        await fs.rename(stage, finalDir);
        if (movedOld) await fs.rm(backup, { recursive: true, force: true });
        const now = new Date().toISOString();
        this.registry.packages[manifest.id] = {
          manifest,
          installedAt: now,
          installedBy: String(actor || ''),
          builtIn: !!builtIn,
          python: pythonInfo,
        };
        await this.save();
        return publicPackage(this.registry.packages[manifest.id], true);
      } catch (error) {
        await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
        if (movedOld) {
          await fs.rm(finalDir, { recursive: true, force: true }).catch(() => {});
          await fs.rename(backup, finalDir).catch(() => {});
        }
        throw error;
      }
    });
  }

  async uninstall(id) {
    return this.withLock(async () => {
      const packageId = extensionId(id);
      const current = this.registry.packages[packageId];
      if (!current) throw httpError(404, '扩展包不存在');
      if (current.builtIn) throw httpError(409, '内置扩展包不能删除，只能通过更高版本替换');
      const target = safeJoin(this.packagesRoot, packageId);
      await fs.rm(target, { recursive: true, force: true });
      delete this.registry.packages[packageId];
      await this.save();
    });
  }

  async installPython(stage, manifest) {
    const python = this.python || await resolvePython(this.spawnCapture);
    const venvDir = path.join(stage, '.venv');
    await this.spawnCapture(python.command, [...python.prefix, '-m', 'venv', venvDir], {
      timeout: INSTALL_TIMEOUT,
      maxOutput: MAX_TOOL_OUTPUT,
      env: safeProcessEnvironment(),
    });
    const executable = venvPython(venvDir);
    const dependencies = manifest.dependencies.python;
    if (dependencies.length) {
      await this.spawnCapture(executable, [
        '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', ...dependencies,
      ], { timeout: INSTALL_TIMEOUT, maxOutput: MAX_TOOL_OUTPUT, env: safeProcessEnvironment() });
    }
    for (const entry of new Set(manifest.tools.map((tool) => tool.entry))) {
      await this.spawnCapture(executable, ['-m', 'py_compile', safeJoin(stage, entry)], {
        timeout: 60_000,
        maxOutput: MAX_TOOL_OUTPUT,
        env: safeProcessEnvironment(),
      });
    }
    return { command: path.relative(stage, executable).split(path.sep).join('/'), dependencies };
  }

  async execute(name, args, context = {}) {
    const found = this.findTool(name);
    if (!found) throw httpError(404, `工具不存在：${name}`);
    validateInput(args, found.tool.inputSchema);
    const missingEnv = found.record.manifest.requiredEnv.filter((key) => !process.env[key]);
    if (missingEnv.length) throw httpError(503, `工具缺少服务器环境变量：${missingEnv.join(', ')}`);
    const packageDir = safeJoin(this.packagesRoot, found.record.manifest.id);
    const extensionDataDir = safeJoin(this.dataRoot, found.record.manifest.id);
    await fs.mkdir(extensionDataDir, { recursive: true });
    const executable = safeJoin(packageDir, found.record.python?.command || '.venv/bin/python');
    const entry = safeJoin(packageDir, found.tool.entry);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-graph-tool-'));
    const workspaceDir = path.join(tempDir, 'workspace');
    const outputDir = path.join(tempDir, 'output');
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });
    try {
      await materializeWorkspace(workspaceDir, context.workspaceFiles || []);
      const payload = {
        protocol: FORMAT,
        tool: found.tool.name,
        action: found.tool.action,
        args: args && typeof args === 'object' && !Array.isArray(args) ? args : {},
        context: {
          workspace: workspaceDir,
          output: outputDir,
          projectId: String(context.projectId || ''),
          workspaceScope: String(context.workspaceScope || ''),
        },
      };
      const result = await this.spawnCapture(executable, [entry], {
        input: JSON.stringify(payload),
        timeout: Number(found.tool.timeoutMs) || TOOL_TIMEOUT,
        maxOutput: MAX_TOOL_OUTPUT,
        signal: context.signal,
        env: {
          ...safeProcessEnvironment(found.record.manifest.requiredEnv),
          PAPER_GRAPH_WORKSPACE: workspaceDir,
          PAPER_GRAPH_OUTPUT: outputDir,
          PAPER_GRAPH_TOOL: found.tool.name,
          PAPER_GRAPH_TOOL_ACTION: found.tool.action,
          PAPER_GRAPH_EXTENSION_DATA: extensionDataDir,
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
        },
      });
      const parsed = parseToolOutput(result.stdout);
      const artifacts = await collectArtifacts(outputDir, parsed.artifacts || []);
      delete parsed.artifacts;
      return {
        result: parsed,
        artifacts,
        tool: { name: found.tool.name, packageId: found.record.manifest.id },
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  findTool(name) {
    for (const record of Object.values(this.registry.packages || {})) {
      const tool = record.manifest.tools.find((item) => item.name === name);
      if (tool) return { record, tool };
    }
    return null;
  }

  async save() {
    const temp = `${this.registryPath}.${randomId('tmp_')}`;
    await fs.writeFile(temp, JSON.stringify(this.registry, null, 2), { mode: 0o600 });
    await replaceFile(temp, this.registryPath);
  }

  withLock(operation) {
    const current = this.lock.catch(() => {}).then(operation);
    this.lock = current.catch(() => {});
    return current;
  }
}

export function toolDefinition(name, description, parameters) {
  return { type: 'function', function: { name, description, parameters } };
}

export async function persistArtifacts(userStore, session, scope, execution) {
  if (!execution.artifacts.length) return [];
  const saved = [];
  await userStore.updateVault(session, (vault) => {
    vault.files ||= {};
    for (const artifact of execution.artifacts) {
      const file = {
        scope,
        path: artifact.path,
        name: artifact.name,
        type: artifact.type,
        size: artifact.size,
        updatedAt: new Date().toISOString(),
        data: artifact.data,
      };
      vault.files[`${scope}::${artifact.path}`] = file;
      saved.push({ ...file, data: undefined });
    }
  });
  return saved;
}

function validateBundle(raw) {
  if (!raw || raw.format !== FORMAT || !raw.manifest || !Array.isArray(raw.files)) {
    throw httpError(400, `扩展包格式必须是 ${FORMAT}`);
  }
  if (raw.files.length > MAX_FILES) throw httpError(400, `扩展包文件不能超过 ${MAX_FILES} 个`);
  const files = raw.files.map((file) => {
    const filePath = relativePath(file?.path);
    const encoding = file?.encoding === 'base64' ? 'base64' : 'utf8';
    const data = String(file?.data || '');
    return { path: filePath, encoding, data };
  });
  const bytes = files.reduce((total, file) => total + (file.encoding === 'base64' ? Buffer.byteLength(file.data, 'base64') : Buffer.byteLength(file.data)), 0);
  if (bytes > MAX_PACKAGE_BYTES) throw httpError(413, `扩展包解码后不能超过 ${MAX_PACKAGE_BYTES / 1024 / 1024} MB`);
  const manifest = validateManifest(raw.manifest, files);
  return { format: FORMAT, manifest, files };
}

function validateManifest(raw, files) {
  const id = extensionId(raw.id);
  const name = shortText(raw.name, '扩展包名称', 80);
  const version = String(raw.version || '').trim();
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw httpError(400, '扩展版本必须使用 semver');
  const description = shortText(raw.description, '扩展包描述', 500);
  const dependencies = {
    python: Array.isArray(raw.dependencies?.python) ? raw.dependencies.python.map(pythonDependency) : [],
  };
  if (dependencies.python.length > 40) throw httpError(400, 'Python 依赖不能超过 40 个');
  const requiredEnv = Array.isArray(raw.requiredEnv) ? [...new Set(raw.requiredEnv.map(environmentName))] : [];
  const available = new Set(files.map((file) => file.path));
  const seenSkills = new Set();
  const skills = (Array.isArray(raw.skills) ? raw.skills : []).map((skill) => {
    const file = relativePath(skill.file);
    if (!available.has(file)) throw httpError(400, `Skill 文件不存在：${file}`);
    const source = files.find((item) => item.path === file);
    if (source.encoding !== 'utf8') throw httpError(400, `Skill 文件必须是 UTF-8：${file}`);
    const skillId = extensionId(skill.id);
    if (seenSkills.has(skillId)) throw httpError(400, `Skill ID 重复：${skillId}`);
    seenSkills.add(skillId);
    return {
      id: skillId,
      name: shortText(skill.name, 'Skill 名称', 80),
      description: shortText(skill.description, 'Skill 描述', 500),
      file,
      instructions: source.data.slice(0, 30_000),
    };
  });
  const seenTools = new Set();
  const tools = (Array.isArray(raw.tools) ? raw.tools : []).map((tool) => {
    const toolName = functionName(tool.name);
    if (seenTools.has(toolName)) throw httpError(400, `工具名重复：${toolName}`);
    seenTools.add(toolName);
    const entry = relativePath(tool.entry);
    if (!available.has(entry) || !entry.endsWith('.py')) throw httpError(400, `Python 工具入口不存在：${entry}`);
    return {
      name: toolName,
      action: shortText(tool.action || toolName, '工具 action', 100),
      description: shortText(tool.description, '工具描述', 1000),
      inputSchema: jsonSchema(tool.inputSchema),
      entry,
      timeoutMs: Math.max(1_000, Math.min(10 * 60_000, Number(tool.timeoutMs) || TOOL_TIMEOUT)),
    };
  });
  if (!skills.length && !tools.length) throw httpError(400, '扩展包至少需要一个 skill 或 tool');
  return { id, name, version, description, dependencies, requiredEnv, skills, tools };
}

async function bundleFromDirectory(dir, manifest) {
  const referenced = new Set([
    ...(manifest.skills || []).map((item) => relativePath(item.file)),
    ...(manifest.tools || []).map((item) => relativePath(item.entry)),
  ]);
  const files = [];
  for (const file of referenced) {
    const data = await fs.readFile(safeJoin(dir, file));
    files.push({ path: file, encoding: isUtf8File(file) ? 'utf8' : 'base64', data: isUtf8File(file) ? data.toString('utf8') : data.toString('base64') });
  }
  return { format: FORMAT, manifest, files };
}

function publicPackage(record, includeInstructions) {
  const missingEnv = record.manifest.requiredEnv.filter((key) => !process.env[key]);
  return {
    id: record.manifest.id,
    name: record.manifest.name,
    version: record.manifest.version,
    description: record.manifest.description,
    installedAt: record.installedAt,
    builtIn: !!record.builtIn,
    ready: missingEnv.length === 0,
    missingEnv,
    dependencies: record.manifest.dependencies,
    skills: record.manifest.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      packageId: record.manifest.id,
      ...(includeInstructions ? { instructions: skill.instructions } : {}),
    })),
    tools: record.manifest.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      packageId: record.manifest.id,
      ready: missingEnv.length === 0,
    })),
  };
}

async function materializeWorkspace(root, files) {
  for (const file of files) {
    const target = safeJoin(root, relativePath(file.path));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.from(file.data || '', 'base64'));
  }
}

async function collectArtifacts(outputDir, requested) {
  if (!Array.isArray(requested)) return [];
  const artifacts = [];
  for (const value of requested.slice(0, 30)) {
    const item = typeof value === 'string' ? { path: value } : value;
    const relative = relativePath(item?.path);
    const source = safeJoin(outputDir, relative);
    const stat = await fs.stat(source);
    if (!stat.isFile()) throw new Error(`工具产物不是文件：${relative}`);
    if (stat.size > MAX_ARTIFACT_BYTES) throw new Error(`工具产物超过 20 MB：${relative}`);
    const data = await fs.readFile(source);
    const workspacePath = relativePath(item.workspacePath || `generated/${path.basename(relative)}`);
    artifacts.push({
      path: workspacePath,
      name: shortText(item.name || path.basename(workspacePath), '产物名称', 180),
      type: shortText(item.type || mimeFor(workspacePath), '产物 MIME', 120),
      size: data.length,
      data: data.toString('base64'),
    });
  }
  return artifacts;
}

function parseToolOutput(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return {};
  try {
    const value = JSON.parse(lines.at(-1));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { value };
    return value;
  } catch {
    return { output: String(stdout).slice(0, MAX_TOOL_OUTPUT) };
  }
}

async function resolvePython(run) {
  const candidates = [
    ...(process.env.PAPER_GRAPH_PYTHON ? [{ command: process.env.PAPER_GRAPH_PYTHON, prefix: [] }] : []),
    { command: 'python3', prefix: [] },
    { command: 'python', prefix: [] },
    ...(process.platform === 'win32' ? [{ command: 'py', prefix: ['-3'] }] : []),
  ];
  for (const candidate of candidates) {
    try {
      await run(candidate.command, [...candidate.prefix, '--version'], { timeout: 10_000, maxOutput: 20_000 });
      return candidate;
    } catch { /* try next */ }
  }
  throw httpError(503, '服务器未找到可用于安装工具依赖的 Python 3');
}

function spawnCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: options.signal,
    });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      finish(Object.assign(new Error(`进程超时：${command}`), { code: 'ETIMEDOUT' }));
    }, options.timeout || TOOL_TIMEOUT);
    timeout.unref?.();
    const capture = (target) => (chunk) => {
      size += chunk.length;
      if (size > (options.maxOutput || MAX_TOOL_OUTPUT)) {
        child.kill();
        finish(new Error('工具输出超过限制'));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.on('error', finish);
    child.on('close', (code) => {
      if (code === 0) finish(null, {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
      else finish(new Error(Buffer.concat(stderr).toString('utf8').trim() || Buffer.concat(stdout).toString('utf8').trim() || `进程退出码 ${code}`));
    });
    if (options.input != null) child.stdin.end(options.input);
    else child.stdin.end();
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    }
  });
}

function normalizeRegistry(value) {
  return {
    version: REGISTRY_VERSION,
    packages: value?.packages && typeof value.packages === 'object' && !Array.isArray(value.packages) ? value.packages : {},
  };
}

function extensionId(value) {
  const id = String(value || '').trim();
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(id)) throw httpError(400, '扩展或 Skill ID 只能使用小写字母、数字和连字符');
  return id;
}

function functionName(value) {
  const name = String(value || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw httpError(400, '工具名必须是函数标识符且不超过 64 字符');
  return name;
}

function shortText(value, label, max) {
  const text = String(value || '').trim();
  if (!text || text.length > max) throw httpError(400, `${label}不能为空且不能超过 ${max} 字符`);
  return text;
}

function environmentName(value) {
  const name = String(value || '').trim();
  if (!/^[A-Z][A-Z0-9_]{1,79}$/.test(name)) throw httpError(400, `无效环境变量名：${name}`);
  return name;
}

function pythonDependency(value) {
  const spec = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\[[A-Za-z0-9_,.-]+\])?(?:\s*(?:===|==|!=|~=|>=|<=|>|<)\s*[A-Za-z0-9.*+!_-]+(?:\s*,\s*(?:===|==|!=|~=|>=|<=|>|<)\s*[A-Za-z0-9.*+!_-]+)*)?$/.test(spec)) {
    throw httpError(400, `不允许的 Python 依赖声明：${spec}`);
  }
  return spec.replace(/\s+/g, '');
}

function jsonSchema(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== 'object') throw httpError(400, '工具 inputSchema 必须是 object JSON Schema');
  const encoded = JSON.stringify(value);
  if (encoded.length > 30_000) throw httpError(400, '工具 inputSchema 过大');
  return JSON.parse(encoded);
}

function validateInput(value, schema, location = 'args', depth = 0) {
  if (depth > 12) throw httpError(400, '工具参数层级过深');
  const type = schema?.type;
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, `${location} 必须是对象`);
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) throw httpError(400, `${location}.${key} 为必填参数`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties || {}, key)) throw httpError(400, `${location}.${key} 不是允许的参数`);
      }
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key)) validateInput(value[key], child, `${location}.${key}`, depth + 1);
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) throw httpError(400, `${location} 必须是数组`);
    if (schema.minItems != null && value.length < schema.minItems) throw httpError(400, `${location} 至少需要 ${schema.minItems} 项`);
    if (schema.maxItems != null && value.length > schema.maxItems) throw httpError(400, `${location} 不能超过 ${schema.maxItems} 项`);
    value.forEach((item, index) => validateInput(item, schema.items || {}, `${location}[${index}]`, depth + 1));
  } else if (type === 'string' && typeof value !== 'string') throw httpError(400, `${location} 必须是字符串`);
  else if (type === 'integer' && !Number.isInteger(value)) throw httpError(400, `${location} 必须是整数`);
  else if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw httpError(400, `${location} 必须是数字`);
  else if (type === 'boolean' && typeof value !== 'boolean') throw httpError(400, `${location} 必须是布尔值`);
  if (Array.isArray(schema?.enum) && !schema.enum.includes(value)) throw httpError(400, `${location} 不是允许的值`);
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) throw httpError(400, `${location} 不能小于 ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) throw httpError(400, `${location} 不能大于 ${schema.maximum}`);
    if (schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum) throw httpError(400, `${location} 必须大于 ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum != null && value >= schema.exclusiveMaximum) throw httpError(400, `${location} 必须小于 ${schema.exclusiveMaximum}`);
  }
}

function relativePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.length > 240 || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw httpError(400, `无效扩展文件路径：${value}`);
  }
  return normalized;
}

function safeJoin(root, relative) {
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw httpError(400, '路径越过扩展目录');
  return target;
}

function venvPython(venvDir) {
  return process.platform === 'win32' ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python');
}

function isUtf8File(file) {
  return /\.(?:py|md|txt|json|ya?ml)$/i.test(file);
}

function mimeFor(file) {
  if (/\.pdf$/i.test(file)) return 'application/pdf';
  if (/\.png$/i.test(file)) return 'image/png';
  if (/\.jpe?g$/i.test(file)) return 'image/jpeg';
  if (/\.json$/i.test(file)) return 'application/json';
  if (/\.(?:md|txt)$/i.test(file)) return 'text/plain';
  return 'application/octet-stream';
}

function safeProcessEnvironment(required = []) {
  const allowed = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC',
    'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR',
    'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  ];
  const env = {};
  for (const key of [...allowed, ...required]) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  return env;
}

async function replaceFile(source, target) {
  try { await fs.rename(source, target); }
  catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
    await fs.copyFile(source, target);
    await fs.rm(source, { force: true });
  }
}
