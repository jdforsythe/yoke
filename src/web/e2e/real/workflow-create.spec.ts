/**
 * Real-backend Playwright spec for t-08 — template picker + new-workflow modal.
 *
 * Covers:
 *   AC-1/2 — GET /api/templates renders one card per template with name + description
 *   AC-3   — clicking a card opens the modal
 *   AC-4   — Create button disabled while name empty; enabled on valid input
 *   AC-5   — 201 response navigates to /workflow/:workflowId
 *   AC-6   — empty state when GET /api/templates returns []
 *   AC-7   — error state with retry when GET /api/templates fails
 *
 * Uses the realBackend fixture (real Fastify + real SQLite, no mocks) for
 * the happy-path test. Individual edge-case tests mock /api/templates via
 * page.route() — registered after the fixture proxy, so route.fallback()
 * correctly delegates to the real backend.
 */

import { test, expect } from '../fixtures/realBackend.js';

test.describe('t-08: template picker + new-workflow modal', () => {
  test('list → modal → create → detail route (AC-1 through AC-5)', async ({ page }) => {
    // The fixture writes .yoke/templates/default.yml (template.name: e2e-test).
    // GET /api/templates returns [{ name: 'e2e-test', description: null }].
    await page.goto('/');

    // AC-1: template card is visible.
    const card = page.getByTestId('template-card-e2e-test');
    await expect(card).toBeVisible();

    // AC-2: card shows the template name.
    await expect(card).toContainText('e2e-test');

    // AC-3: clicking the card opens the modal.
    await card.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // AC-4: Create button is disabled while name is empty.
    const createBtn = dialog.getByRole('button', { name: 'Create' });
    await expect(createBtn).toBeDisabled();

    // Type a workflow name — Create button becomes enabled.
    const nameInput = dialog.getByLabel('Workflow name');
    await nameInput.fill('My Integration Run');
    await expect(createBtn).toBeEnabled();

    // AC-5: submit → navigate to /workflow/:workflowId.
    await createBtn.click();
    await expect(page).toHaveURL(/\/workflow\/.+/, { timeout: 5000 });
  });

  test('Create button stays disabled for whitespace-only name (AC-4)', async ({ page }) => {
    await page.goto('/');

    await page.getByTestId('template-card-e2e-test').click();
    const dialog = page.getByRole('dialog');
    const createBtn = dialog.getByRole('button', { name: 'Create' });
    const nameInput = dialog.getByLabel('Workflow name');

    // Whitespace-only — still treated as empty, button stays disabled.
    await nameInput.fill('   ');
    await expect(createBtn).toBeDisabled();

    // Adding non-whitespace enables the button.
    await nameInput.fill('  Real Name  ');
    await expect(createBtn).toBeEnabled();
  });

  test('Escape closes the modal without navigating (RC: accessible)', async ({ page }) => {
    await page.goto('/');

    await page.getByTestId('template-card-e2e-test').click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();

    // Still on the template picker, not navigated away.
    await expect(page).toHaveURL('/');
  });

  test('name validation error shown on blur when empty (AC-4)', async ({ page }) => {
    await page.goto('/');

    await page.getByTestId('template-card-e2e-test').click();
    const dialog = page.getByRole('dialog');

    // Focus and immediately blur the name input without typing.
    const nameInput = dialog.getByLabel('Workflow name');
    await nameInput.focus();
    await nameInput.blur();

    await expect(dialog.getByRole('alert')).toContainText('Name is required');
  });

  test('empty state shown when no templates configured (AC-6)', async ({ page, backend: _ }) => {
    // Override /api/templates to return an empty list for this test.
    await page.route('**/api/templates', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ templates: [] }),
      }),
    );

    await page.goto('/');

    await expect(page.getByTestId('empty-state')).toContainText(
      'Create a template file in .yoke/templates/*.yml to get started',
    );
  });

  test('error state shown on 500, Retry reloads templates (AC-7)', async ({ page, backend: _ }) => {
    let callCount = 0;
    await page.route('**/api/templates', async (route) => {
      callCount++;
      if (callCount === 1) {
        await route.fulfill({ status: 500, body: 'Internal Server Error' });
      } else {
        // Pass through to the real backend proxy registered by the fixture.
        await route.fallback();
      }
    });

    await page.goto('/');

    // Error state.
    await expect(page.getByText('Failed to load templates.')).toBeVisible();
    const retryBtn = page.getByRole('button', { name: 'Retry' });
    await expect(retryBtn).toBeVisible();

    // Retry triggers a second fetch which succeeds via the fixture proxy.
    await retryBtn.click();
    await expect(page.getByTestId('template-card-e2e-test')).toBeVisible();
  });

  test('template description rendered on card when present (AC-2)', async ({ page, backend: _ }) => {
    // Return a template with a description via route mock.
    await page.route('**/api/templates', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          templates: [
            { name: 'basic', description: null },
            { name: 'full-pipeline', description: 'Runs the complete review pipeline.' },
          ],
        }),
      }),
    );

    await page.goto('/');

    await expect(page.getByTestId('template-card-full-pipeline')).toContainText(
      'Runs the complete review pipeline.',
    );
    // Card with null description shows only the name (no extra text).
    await expect(page.getByTestId('template-card-basic')).toContainText('basic');
  });
});
