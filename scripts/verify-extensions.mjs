import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExtensionRegistry } from '../server/extensionRegistry.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracegraph-extension-verify-'));
try {
  const registry = new ExtensionRegistry(root, {
    builtinsRoot: path.resolve('extensions/builtin'),
  });
  await registry.init();
  const catalog = registry.list();
  assert.deepEqual(catalog.packages.map((item) => item.id).sort(), ['paddle-ocr', 'pdf-workbench']);
  assert.equal(catalog.tools.some((item) => item.name === 'pdf_create_text'), true);
  assert.equal(catalog.tools.some((item) => item.name === 'paddle_ocr'), true);

  const created = await registry.execute('pdf_create_text', {
    text: 'Tracegraph extension verification\nPDF tools are available.\n中文 PDF 工具可用。',
    title: 'Verification',
    output: 'verification.pdf',
  });
  assert.equal(created.artifacts.length, 1);
  const workspaceFiles = created.artifacts.map((artifact) => ({ ...artifact, scope: 'verify' }));

  const info = await registry.execute('pdf_info', { file: 'generated/verification.pdf' }, {
    workspaceFiles,
    workspaceScope: 'verify',
  });
  assert.equal(info.result.pages, 1);

  const rendered = await registry.execute('pdf_render', {
    file: 'generated/verification.pdf',
    pages: '1',
    dpi: 100,
  }, { workspaceFiles, workspaceScope: 'verify' });
  assert.equal(rendered.artifacts[0].type, 'image/png');
  assert.ok(rendered.artifacts[0].size > 1000);

  console.log(JSON.stringify({
    packages: catalog.packages.map((item) => ({
      id: item.id,
      ready: item.ready,
      tools: item.tools.length,
      dependencies: item.dependencies.python,
    })),
    pdf: { pages: info.result.pages, renderedBytes: rendered.artifacts[0].size },
  }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
