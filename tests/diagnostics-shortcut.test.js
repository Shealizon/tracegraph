// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDiagnostics } from '../src/debug/diagnostics.js';

describe('debug export shortcut', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('arms every source module and downloads the current diagnostics on Ctrl+F10', () => {
    vi.useFakeTimers();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:debug-log');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    installDiagnostics({ getContext: () => ({ screen: 'test' }) });

    const event = new KeyboardEvent('keydown', {
      key: 'F10',
      code: 'F10',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    const snapshot = window.__entailDebug.snapshot();
    const sourceModules = snapshot.moduleBreakpoints.filter((item) => item.module.startsWith('src/'));
    const sourceModuleCount = countJsFiles(path.join(process.cwd(), 'src'));
    expect(event.defaultPrevented).toBe(true);
    expect(click).toHaveBeenCalledOnce();
    expect(sourceModules).toHaveLength(sourceModuleCount);
    expect(sourceModules.every((item) => item.status === 'armed')).toBe(true);
    expect(snapshot.records.some((item) => item.module === 'runtime/diagnostics' && item.event === 'export')).toBe(true);
  });
});

function countJsFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).reduce((count, entry) => {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) return count + countJsFiles(child);
    return count + (entry.isFile() && entry.name.endsWith('.js') ? 1 : 0);
  }, 0);
}
