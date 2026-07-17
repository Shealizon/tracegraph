// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  users: vi.fn(),
  adminCodexStatus: vi.fn(),
  adminExtensions: vi.fn(),
  saveExtensionEnvironment: vi.fn(),
  deleteExtensionEnvironment: vi.fn(),
  createUser: vi.fn(),
}));

vi.mock('../src/cloud/api.js', () => ({ serverApi: api }));
vi.mock('../src/cloud/accountUi.js', () => ({ mountAccountControls: vi.fn() }));
vi.mock('../src/cloud/session.js', () => ({
  sessionSnapshot: () => ({ user: { id: 'admin', role: 'admin', name: 'Admin' } }),
}));
vi.mock('../src/ui/feedback.js', () => ({ toast: vi.fn() }));

import { renderAdminPage } from '../src/cloud/adminPage.js';

describe('admin extension UI', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div><div id="leading-root"></div>';
    localStorage.clear();
    localStorage.setItem('hg-theme-mode', 'light');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    api.users.mockResolvedValue({ users: [{ id: 'admin', role: 'admin', status: 'active', name: 'Admin', email: 'admin@example.com' }] });
    api.adminCodexStatus.mockResolvedValue({ authenticated: true, enabled: true, authMethod: 'test' });
    api.adminExtensions.mockResolvedValue({
      failures: [],
      packages: [{
        id: 'paddle-ocr',
        name: 'PaddleOCR',
        version: '1.0.0',
        description: '识别扫描 PDF。',
        builtIn: true,
        ready: false,
        missingEnv: ['PADDLEOCR_TOKEN'],
        environment: [{ key: 'PADDLEOCR_TOKEN', configured: false, source: '' }],
        dependencies: { python: ['requests>=2.32,<3'] },
        skills: [{ name: 'PaddleOCR' }],
        tools: [{ name: 'paddle_ocr' }],
      }],
    });
    api.saveExtensionEnvironment.mockResolvedValue({ environment: { key: 'PADDLEOCR_TOKEN', configured: true } });
  });

  it('uses the stored theme and renders a secure inline token editor', async () => {
    await renderAdminPage();

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.querySelectorAll('.admin-extension-card')).toHaveLength(1);
    expect(document.body.textContent).toContain('PADDLEOCR_TOKEN');
    expect(document.body.textContent).toContain('尚未配置');
    expect(document.body.innerHTML).not.toContain('token-value');

    document.querySelector('[data-secret-open]').click();
    const form = document.querySelector('[data-secret-form]');
    const input = form.querySelector('input');
    expect(form.hidden).toBe(false);
    expect(input.type).toBe('password');
    input.value = 'token-value';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(api.saveExtensionEnvironment).toHaveBeenCalledWith('PADDLEOCR_TOKEN', 'token-value'));
  });

  it('creates a managed user and shows the one-time credentials', async () => {
    api.createUser.mockResolvedValue({
      user: { id: 'alice', username: 'alice', name: 'alice', email: 'alice@graph.akusm.com', role: 'user', status: 'active' },
      initialPassword: 'aliceabcde@graph.akusm.com',
    });
    await renderAdminPage();

    document.querySelector('[data-user-create]').click();
    const form = document.querySelector('.auth-dialog');
    form.elements.namedItem('username').value = 'Alice';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(api.createUser).toHaveBeenCalledWith('Alice'));
    expect(document.querySelector('[data-created-username]').value).toBe('alice');
    expect(document.querySelector('[data-created-password]').value).toBe('aliceabcde@graph.akusm.com');
    expect(document.body.textContent).toContain('关闭后无法再次查看初始密码');
  });
});
