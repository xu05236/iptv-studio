import { expect, test } from '@playwright/test';

// The admin SPA keeps the session token in localStorage, so seeding it here is
// equivalent to logging in and avoids depending on the login form's markup.
const TOKEN_KEY = 'iptv.admin.session';
const token = process.env.E2E_ADMIN_TOKEN ?? '';

test.skip(!token, 'E2E_ADMIN_TOKEN 未设置：跳过线上冒烟');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    [TOKEN_KEY, token],
  );
});

test('订阅页：自定义池组合可选池并有全选/清空', async ({ page }) => {
  await page.goto('/admin/subscriptions', { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await expect(page.getByRole('heading', { name: '订阅与导出' })).toBeVisible();
  await page.getByRole('button', { name: '新建订阅' }).click();

  const poolMode = page.locator('select', { has: page.locator('option[value="pools"]') });
  await poolMode.selectOption('pools');
  await expect(page.getByRole('button', { name: '全选', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '清空', exact: true })).toBeVisible();

  const premiumChip = page.locator('button.chip', { hasText: '精品池' }).first();
  await premiumChip.click();
  await expect(premiumChip).toHaveClass(/chip--active/);
});

test('线路池页：自定义池与清理已删源按钮可见', async ({ page }) => {
  await page.goto('/admin/pool', { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await expect(page.getByRole('heading', { name: '线路池' })).toBeVisible();
  await expect(page.getByRole('button', { name: '自定义池' })).toBeVisible();
  await expect(page.getByRole('button', { name: '清理已删源' })).toBeVisible();
  await page.getByRole('button', { name: '自定义池' }).click();
  await expect(page.getByText('新建池', { exact: true })).toBeVisible();
});

test('频道页：未识别频道入口可打开', async ({ page }) => {
  await page.goto('/admin/channels', { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await expect(page.getByRole('heading', { name: '频道', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '未识别频道' }).click();
  await expect(page.getByText('最近合并')).toBeVisible();
});
