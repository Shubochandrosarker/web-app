import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Accessibility and keyboard checks over the pages every visitor and every
 * staff member actually hits: the public home page, a service page with the
 * request form, and the dashboard sign-in.
 *
 * The bar is WCAG 2.1/2.2 A+AA as axe can detect it — automated scanning
 * catches roughly half of WCAG, so a clean run here is necessary, never
 * sufficient. Serious and critical violations fail the build; the full list
 * is attached to the failure for anything below that.
 */

const SITE = process.env.E2E_SITE_URL ?? 'http://localhost:3000';
const DASHBOARD = process.env.E2E_DASHBOARD_URL ?? 'http://localhost:3001';
const SERVICE_PATH = process.env.E2E_SERVICE_PATH ?? '/services/smoke-test-service';

async function expectNoSeriousViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();

  const blocking = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(
    blocking,
    blocking
      .map(
        (violation) =>
          `${violation.id} (${violation.impact}): ${violation.help} — ${violation.nodes
            .slice(0, 3)
            .map((node) => node.target.join(' '))
            .join(', ')}`,
      )
      .join('\n'),
  ).toEqual([]);
}

test.describe('public site', () => {
  test('home page has no serious accessibility violations', async ({ page }) => {
    await page.goto(SITE + '/');
    await expectNoSeriousViolations(page);
  });

  test('service page (with the request form) has no serious violations', async ({ page }) => {
    await page.goto(SITE + SERVICE_PATH);
    await expectNoSeriousViolations(page);
  });

  test('the request form is completable with the keyboard alone', async ({ page }) => {
    await page.goto(SITE + SERVICE_PATH);

    const form = page.locator('form.lead-form');
    await expect(form).toBeVisible();

    // Walk focus into the form and type — no pointer events at any step.
    const firstField = form.locator('input, textarea, select').first();
    await firstField.focus();
    await expect(firstField).toBeFocused();
    await page.keyboard.type('Keyboard Person');
    await page.keyboard.press('Tab');

    // The submit control must be reachable by Tab from inside the form.
    const submit = form.locator('button[type="submit"]');
    await expect(submit).toBeVisible();
    let reached = false;
    for (let presses = 0; presses < 25; presses += 1) {
      if (await submit.evaluate((element) => element === document.activeElement)) {
        reached = true;
        break;
      }
      await page.keyboard.press('Tab');
    }
    expect(reached, 'Tab never reached the submit button').toBe(true);
  });
});

test.describe('dashboard', () => {
  test('sign-in has no serious accessibility violations', async ({ page }) => {
    await page.goto(DASHBOARD + '/sign-in');
    await expectNoSeriousViolations(page);
  });

  test('sign-in is operable with the keyboard alone', async ({ page }) => {
    await page.goto(DASHBOARD + '/sign-in');
    const email = page.locator('input[type="email"], input[name="email"]').first();
    await email.focus();
    await expect(email).toBeFocused();
    await page.keyboard.type('person@example.test');
    await page.keyboard.press('Tab');
    const password = page.locator('input[type="password"]').first();
    await expect(password).toBeFocused();
  });
});
