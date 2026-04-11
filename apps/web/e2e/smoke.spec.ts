import { test, expect } from '@playwright/test';

test.describe('QWAI smoke — unauthenticated', () => {
  test('landing renders', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /personal ai trading agent/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /connect wallet/i })).toBeVisible();
  });

  test('login page renders wallet options', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('button', { name: /metamask/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /phantom/i })).toBeVisible();
  });

  test('dashboard redirects to login when unauthenticated', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForURL(/\/login/);
    expect(page.url()).toMatch(/\/login/);
  });
});

test.describe('QWAI smoke — authenticated (mocked)', () => {
  test.beforeEach(async ({ page }) => {
    // Seed localStorage with fake tokens so AuthGate lets us through;
    // API calls are mocked below.
    await page.addInitScript(() => {
      window.localStorage.setItem(
        'qwai.auth',
        JSON.stringify({ accessToken: 'fake.jwt.token', refreshToken: 'fake.refresh' }),
      );
    });

    await page.route('**/api/wallets', (route) =>
      route.fulfill({ json: [{ id: 'w1', chain: 'SOLANA', address: 'SoLaNaAddr123456789', isPrimary: true }] }),
    );
    await page.route('**/api/orders', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/guardrails', (route) =>
      route.fulfill({
        json: { perTradeUsd: 500, dailyUsd: 2000, maxSlippageBps: 150, whitelist: [], blacklist: [], killSwitch: false },
      }),
    );
    await page.route('**/api/me', (route) => route.fulfill({ json: { paperMode: true } }));
    await page.route('**/api/token-intel/analyze', (route) =>
      route.fulfill({
        json: {
          chain: 'SOLANA',
          address: 'SoLaNaAddr123456789',
          symbol: 'TEST',
          name: 'Test Token',
          priceUsd: 0.0123,
          securityScore: 7.5,
          convictionScore: 6.8,
          securityFlags: [],
        },
      }),
    );
  });

  test('dashboard renders portfolio and token intel card', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByText(/QWAI Chat/i)).toBeVisible();
    await expect(page.getByText(/Token Intel/i)).toBeVisible();
    await expect(page.getByText(/Portfolio/i)).toBeVisible();
  });

  test('paste-and-analyze flow shows conviction score', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByPlaceholder(/paste contract address/i).fill('SoLaNaAddr123456789');
    await page.getByRole('button', { name: /analyze/i }).click();
    await expect(page.getByText(/TEST/)).toBeVisible();
    await expect(page.getByText(/6\.8\/10/)).toBeVisible();
  });

  test('settings page shows guardrails and telegram link', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByText(/Guardrails/i)).toBeVisible();
    await expect(page.getByText(/Link Telegram/i)).toBeVisible();
  });
});
