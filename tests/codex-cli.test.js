import { describe, expect, it } from 'vitest';
import { buildCodexExecArgs, formatCodexFailure, normalizeCodexModels } from '../server/codexCli.mjs';

describe('server Codex adapter', () => {
  it('normalizes the app-server model catalog and hides hidden entries', () => {
    expect(normalizeCodexModels([
      {
        id: 'catalog-id', model: 'gpt-current', displayName: 'GPT Current', description: 'Default model',
        hidden: false, isDefault: true, defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }],
      },
      { id: 'hidden', model: 'hidden', hidden: true },
    ])).toEqual([{
      id: 'gpt-current', displayName: 'GPT Current', description: 'Default model', isDefault: true,
      defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium'],
    }]);
  });

  it('passes an explicit selected model and reads the prompt from stdin', () => {
    const args = buildCodexExecArgs({ model: 'gpt-current', outputPath: '/tmp/final.md' });
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-current');
    expect(args.at(-1)).toBe('-');
    expect(args).toContain('--json');
    expect(args).toContain('read-only');
  });

  it('maps the legacy codex placeholder to the CLI default model', () => {
    const args = buildCodexExecArgs({ model: 'codex', outputPath: '/tmp/final.md' });
    expect(args).not.toContain('--model');
  });

  it('turns a region failure into an actionable server error', () => {
    expect(formatCodexFailure('unsupported_country_region_territory')).toContain('HTTPS_PROXY');
  });
});
