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
 * The full list → modal → create → detail flow uses the real backend.
 * Edge-case tests mock GET /api/templates and POST /api/workflows so they
 * can run without the full proxy stack (just `page`, no backend fixture).
 */

import { test as realTest, expect } from '../fixtures/realBackend.js';
import { test as mockTest } from '@playwright/test';

// Mock template for edge-case tests.
const MOCK_TEMPLATES = [{ name: 'e2e-test', description: null }];

function fulfillTemplates(templates: typeof MOCK_TEMPLATES) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ templates }),
  };
}

// ---------------------------------------------------------------------------
// Happy path — requires real Fastify + SQLite backend
// ---------------------------------------------------------------------------

realTest.describe('t-08: workflow create — real backend', () => {
  realTest(
    'list → modal → create → detail route (AC-1 through AC-5)',
    async ({ page, backend }) => {
      // The fixture writes .yoke/templates/default.yml. listTemplates uses the
      // filename as the template name, so GET /api/templates returns [{ name: 'default' }].
      void backend; // fixture instantiation sets up the proxy; we don't need db here

      await page.goto('/');

      // AC-1/2: template card visible with name.
      const card = page.getByTestId('template-card-default');
      await expect(card).toBeVisible();
      await expect(card).toContainText('default');

      // AC-3: clicking the card opens the modal.
      await card.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();

      // AC-4: Create button disabled while name is empty.
      const createBtn = dialog.getByRole('button', { name: 'Create' });
      await expect(createBtn).toBeDisabled();

      // Entering a name enables the button.
      const nameInput = dialog.getByLabel('Workflow name');
      await nameInput.fill('My Integration Run');
      await expect(createBtn).toBeEnabled();

      // AC-5: submit → navigate to /workflow/:workflowId.
      await createBtn.click();
      await expect(page).toHaveURL(/\/workflow\/.+/, { timeout: 5000 });
    },
  );
});

// ---------------------------------------------------------------------------
// Edge-case tests — mock the API, no backend fixture needed
// ---------------------------------------------------------------------------

mockTest.describe('t-08: workflow create — mocked', () => {
  mockTest.beforeEach(async ({ page }) => {
    // Intercept GET /api/templates for every test in this describe block.
    await page.route('**/api/templates', (route) =>
      route.fulfill(fulfillTemplates(MOCK_TEMPLATES)),
    );
    // Intercept POST /api/workflows to return a fake 201 with a workflowId.
    await page.route('**/api/workflows', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            workflowId: 'wf-mock-001',
            name: 'mocked-run',
            sameTemplateNames: [],
          }),
        });
      } else {
        await route.fallback();
      }
    });
    // Intercept GET /api/workflows so the sidebar renders without a real server.
    await page.route('**/api/workflows*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ workflows: [], hasMore: false }),
      }),
    );
  });

  mockTest(
    'Create button stays disabled for whitespace-only name (AC-4)',
    async ({ page }) => {
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
    },
  );

  mockTest(
    'Escape closes the modal without navigating (RC: accessible)',
    async ({ page }) => {
      await page.goto('/');

      await page.getByTestId('template-card-e2e-test').click();
      await expect(page.getByRole('dialog')).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).not.toBeVisible();

      // Still on the template picker, not navigated away.
      await expect(page).toHaveURL('/');
    },
  );

  mockTest(
    'name validation error shown on blur when empty (AC-4)',
    async ({ page }) => {
      await page.goto('/');

      await page.getByTestId('template-card-e2e-test').click();
      const dialog = page.getByRole('dialog');

      // Focus then blur the input without typing — should show validation error.
      const nameInput = dialog.getByLabel('Workflow name');
      await nameInput.focus();
      await nameInput.blur();

      await expect(dialog.getByRole('alert')).toContainText('Name is required');
    },
  );

  mockTest(
    'empty state shown when no templates configured (AC-6)',
    async ({ page }) => {
      // Override the beforeEach mock to return empty templates.
      await page.route('**/api/templates', (route) =>
        route.fulfill(fulfillTemplates([])),
      );

      await page.goto('/');

      await expect(page.getByTestId('empty-state')).toContainText(
        'Create a template file in .yoke/templates/*.yml to get started',
      );
    },
  );

  mockTest(
    'error state shown on 500, Retry reloads templates (AC-7)',
    async ({ page }) => {
      let callCount = 0;
      await page.route('**/api/templates', async (route) => {
        callCount++;
        if (callCount === 1) {
          await route.fulfill({ status: 500, body: 'Internal Server Error' });
        } else {
          await route.fulfill(fulfillTemplates(MOCK_TEMPLATES));
        }
      });

      await page.goto('/');

      // Error state.
      await expect(page.getByText('Failed to load templates.')).toBeVisible();
      const retryBtn = page.getByRole('button', { name: 'Retry' });
      await expect(retryBtn).toBeVisible();

      // Retry fetches again and shows template cards.
      await retryBtn.click();
      await expect(page.getByTestId('template-card-e2e-test')).toBeVisible();
    },
  );

  mockTest(
    'template description rendered on card when present (AC-2)',
    async ({ page }) => {
      await page.route('**/api/templates', (route) =>
        route.fulfill(
          fulfillTemplates([
            { name: 'basic', description: null },
            { name: 'full-pipeline', description: 'Runs the complete review pipeline.' },
          ]),
        ),
      );

      await page.goto('/');

      await expect(page.getByTestId('template-card-full-pipeline')).toContainText(
        'Runs the complete review pipeline.',
      );
      // Card with null description shows only the name (no extra text below it).
      await expect(page.getByTestId('template-card-basic')).toContainText('basic');
    },
  );

  mockTest(
    'backdrop click closes the modal (RC: accessible)',
    async ({ page }) => {
      await page.goto('/');

      await page.getByTestId('template-card-e2e-test').click();
      await expect(page.getByRole('dialog')).toBeVisible();

      // Click the backdrop at a corner well outside the centered dialog panel.
      await page.getByTestId('modal-backdrop').click({ position: { x: 10, y: 10 } });
      await expect(page.getByRole('dialog')).not.toBeVisible();
    },
  );
});
