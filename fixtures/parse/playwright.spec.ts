import { test, expect } from '@playwright/test';

test.describe('checkout', () => {
  test.describe.configure({ timeout: 60_000 });

  test('shows the total', async ({ page }) => {
    await page.goto('/cart');
    await expect(page.getByTestId('total')).toHaveText('$10.00');
    await expect(page.getByRole('button', { name: 'Pay' })).toBeVisible();
    await expect.soft(page.locator('h1')).toContainText('Cart');
  });

  test.fixme('broken flow', async ({ page }) => {
    await expect(page).toHaveURL('/broken');
  });

  test('conditional skip inside the body is not a test', async ({ page }) => {
    test.skip(page.viewportSize()!.width < 600, 'desktop only');
    await expect(page).toHaveTitle(/Shop/);
  });
});

test('top level with a timeout', async ({ page }) => {
  test.setTimeout(90_000);
  await expect.poll(() => page.title()).toBe('Shop');
});
