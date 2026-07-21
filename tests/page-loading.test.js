import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function bootPage(theme = 'light') {
  return new JSDOM(html, {
    url: 'https://tracegraph.test/',
    runScripts: 'dangerously',
    beforeParse(window) {
      window.matchMedia = () => ({ matches: false });
      window.localStorage.setItem('hg-theme-mode', theme);
    },
  });
}

describe('page loading shell', () => {
  it('applies the stored light theme before the app initializes', () => {
    const dom = bootPage('light');
    const { document } = dom.window;

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.classList.contains('is-app-loading')).toBe(true);
    expect(dom.window.getComputedStyle(document.body).backgroundColor).toBe('rgb(246, 246, 244)');
    expect(dom.window.getComputedStyle(document.getElementById('app')).visibility).toBe('hidden');
  });

  it('keeps the current page visible while navigation restarts the progress bar', () => {
    const dom = bootPage('light');
    const { document } = dom.window;
    const progress = document.getElementById('app-loading');
    document.documentElement.classList.remove('is-app-loading');
    progress.classList.add('is-complete');

    dom.window.dispatchEvent(new dom.window.Event('beforeunload'));

    expect(document.documentElement.classList.contains('is-app-loading')).toBe(false);
    expect(progress.classList.contains('is-complete')).toBe(false);
    expect(dom.window.getComputedStyle(document.getElementById('app')).visibility).toBe('visible');
  });
});
