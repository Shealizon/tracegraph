import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { clampCollapsedPosition } from '../src/ui/aiPanel.js';

describe('AI panel collapsed shell', () => {
  it('keeps the collapse control inside the shared panel header', () => {
    const source = fs.readFileSync(new URL('../src/ui/aiPanel.js', import.meta.url), 'utf8');
    const styles = fs.readFileSync(new URL('../src/styles/ai-panel.css', import.meta.url), 'utf8');
    const headerStart = source.indexOf('<header class="ai-head">');
    const collapseButton = source.indexOf('class="ai-collapse-rail"', headerStart);
    const headerEnd = source.indexOf('</header>', headerStart);

    expect(headerStart).toBeGreaterThan(-1);
    expect(collapseButton).toBeGreaterThan(headerStart);
    expect(collapseButton).toBeLessThan(headerEnd);
    expect(styles).toContain('.ai-collapse-rail { position: relative;');
    expect(styles).not.toContain('.ai-collapse-rail { position: absolute;');
    expect(styles).not.toContain('left: -28px');
    expect(styles).toContain('.ai-panel.is-collapsed { inset: 10px 10px auto auto; width: min(390px');
  });

  it('restores the same collapsed position after an expand-collapse cycle', () => {
    const saved = clampCollapsedPosition({ left: 312, top: 184 }, {
      viewportWidth: 1440,
      viewportHeight: 900,
    });
    const restored = clampCollapsedPosition(saved, {
      viewportWidth: 1440,
      viewportHeight: 900,
    });

    expect(saved).toEqual({ left: 312, top: 184 });
    expect(restored).toEqual(saved);
    expect(clampCollapsedPosition({ left: 2000, top: 2000 }, {
      viewportWidth: 1440,
      viewportHeight: 900,
    })).toEqual({ left: 1040, top: 834 });
  });
});
