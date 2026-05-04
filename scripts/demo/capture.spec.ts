/**
 * Demo dashboard capture — produces docs/img/*.png from the seeded
 * $YOKE_DEMO_DIR. The DB must already be seeded by `make demo-seed`
 * (the Makefile target chains that step before invoking playwright).
 */

import { test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { RUNNING_WORKFLOW_ID, RUNNING_IN_PROGRESS_ITEM_ID } from './fixture.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const PORT = parseInt(process.env.YOKE_DEMO_PORT ?? '7793', 10);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const OUTDIR = path.join(REPO_ROOT, 'docs', 'img');
const DEMO_DIR = process.env.YOKE_DEMO_DIR;

if (!DEMO_DIR) {
  throw new Error('YOKE_DEMO_DIR env var is required (set by `make demo-shots`).');
}

let yokePid: number | null = null;

async function waitForYoke(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE_URL}/api/templates`);
      if (r.ok) return;
    } catch {
      /* server not listening yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('yoke did not become ready within 30s');
}

test.beforeAll(async () => {
  const yokeBin = path.join(REPO_ROOT, 'bin/yoke');
  // --no-scheduler keeps the seeded data static (paused_at would also do it,
  // but --no-scheduler avoids any startup auto-pause logic touching rows).
  // --template plan-build-review is required because the picker has 5 options
  // and start.ts refuses to boot without an explicit pick.
  const child: ChildProcess = spawn(
    yokeBin,
    [
      'start',
      '--config-dir',
      DEMO_DIR!,
      '--port',
      String(PORT),
      '--no-scheduler',
      '--template',
      'plan-build-review',
    ],
    { stdio: 'pipe', detached: false },
  );
  yokePid = child.pid ?? null;
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});
  await waitForYoke();
});

test.afterAll(async () => {
  if (yokePid) {
    try {
      process.kill(yokePid, 'SIGINT');
    } catch {
      /* already gone */
    }
    await new Promise((r) => setTimeout(r, 2_000));
    try {
      process.kill(yokePid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Hide the PausedBanner via a stylesheet injection. Every seeded workflow has
 * paused_at set to freeze the scheduler — without this CSS the orange banner
 * would dominate every workflow-detail screenshot. Applied per-page rather
 * than at the server because un-pausing the workflow would let the scheduler
 * mutate the seeded data we're trying to capture.
 *
 * Apply to ALL captures EXCEPT feature-board.png — that one deliberately
 * shows the paused banner so users see what it looks like in the docs.
 */
async function hidePausedBanner(page: Page): Promise<void> {
  await page.addStyleTag({
    content: '[data-testid="paused-banner"]{display:none !important;}',
  });
}

async function gotoWorkflow(page: Page, opts: { hideBanner?: boolean } = {}): Promise<void> {
  await page.goto(`${BASE_URL}/workflow/${RUNNING_WORKFLOW_ID}`, { waitUntil: 'networkidle' });
  if (opts.hideBanner !== false) await hidePausedBanner(page);
  // FeatureBoard cards render the stableId fallback because the server's WS
  // snapshot always sends displayTitle=null. Wait for that text.
  await page.waitForSelector('text=idempotency-on-retry', { timeout: 15_000 });
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

test('picker', async ({ page }) => {
  // Landing route at "/" renders the template picker (WorkflowListRoute).
  // The sidebar still shows the running workflow but the main pane is the
  // 5-template grid — that's what makes this distinct from workflow-list.
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await hidePausedBanner(page);
  await page.waitForSelector('[data-testid^="template-card-"]', { timeout: 10_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUTDIR, 'picker.png'), fullPage: false });
});

test('workflow-list', async ({ page }) => {
  // Navigate to a workflow detail URL with ?archived=true so the sidebar shows
  // BOTH the running workflow and the two archived ones — that's the
  // distinguishing content vs picker.png. Crop to the sidebar so the orange
  // banner / item list don't dominate the shot.
  await page.goto(`${BASE_URL}/workflow/${RUNNING_WORKFLOW_ID}?archived=true`, {
    waitUntil: 'networkidle',
  });
  await hidePausedBanner(page);
  await page.waitForSelector('text=Add billing webhooks', { timeout: 15_000 });
  await page.waitForSelector('text=Add OAuth flow', { timeout: 15_000 });
  await page.waitForSelector('text=Refactor session log', { timeout: 15_000 });
  await page.waitForTimeout(500);
  // Clip to top-left covering the header + sidebar (sidebar is 256px wide via
  // --sidebar-width; widen slightly to include a sliver of main pane border).
  await page.screenshot({
    path: path.join(OUTDIR, 'workflow-list.png'),
    clip: { x: 0, y: 0, width: 320, height: 480 },
  });
});

test('live-stream', async ({ page }) => {
  await gotoWorkflow(page);
  // Click the in-progress item to focus its session in LiveStreamPane.
  const idemRow = page.locator('text=idempotency-on-retry').first();
  await idemRow.click();
  // Wait for the History tab to populate (timeline fetch lands).
  await page.waitForSelector('[data-testid="tab-history"]:not([disabled])', { timeout: 10_000 });
  // The Live tab is empty on a paused workflow (no in-flight WS frames).
  // Switch to History and click the running session row — loadSessionIntoStore
  // fetches /api/sessions/:id/log and hydrates the render store.
  await page.getByTestId('tab-history').click({ force: true });
  await page.waitForTimeout(500);
  // Click the session row by its stable testid (one row exists for the running session).
  await page.locator('[data-testid^="history-session-"]').first().click({ force: true });
  await page.waitForSelector(
    'text=/reading the existing webhook handler|Migration written|Writing the migration/',
    { timeout: 20_000 },
  );
  await page.waitForTimeout(1_000);
  await page.screenshot({ path: path.join(OUTDIR, 'live-stream.png'), fullPage: false });
});

test('item-detail', async ({ page }) => {
  // Use the explicit deep-link route /workflow/:id/item/:itemId so the
  // FeatureBoard scrolls to + highlights the in-progress item card. Crop
  // tightly to the item card area so the screenshot is visually distinct
  // from live-stream.png (which features the right-pane transcript).
  await page.goto(
    `${BASE_URL}/workflow/${RUNNING_WORKFLOW_ID}/item/${RUNNING_IN_PROGRESS_ITEM_ID}`,
    { waitUntil: 'networkidle' },
  );
  await hidePausedBanner(page);
  await page.waitForSelector('text=idempotency-on-retry', { timeout: 15_000 });
  // Click the item to expand "Show data" so the detail view shows item data.
  const idemRow = page.locator('text=idempotency-on-retry').first();
  await idemRow.click();
  await page.waitForTimeout(800);
  // Click "Show data" disclosure to expose the per-item JSON payload.
  const showData = page.locator('text=Show data').first();
  if (await showData.count() > 0) {
    await showData.click({ force: true }).catch(() => {});
  }
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUTDIR, 'item-detail.png'), fullPage: false });
});

test('feature-board', async ({ page }) => {
  // DELIBERATE EXCEPTION: feature-board.png is the one screenshot that keeps
  // the PausedBanner visible so users see what the resume affordance looks
  // like in context. All other workflow-detail captures hide it via
  // hidePausedBanner() because every seeded workflow has paused_at set.
  await gotoWorkflow(page, { hideBanner: false });
  // Default activeView === 'list' shows FeatureBoard. Cards render the
  // stableId fallback (server WS snapshot sends displayTitle=null).
  await page.waitForSelector('text=verify-stripe-signature', { timeout: 15_000 });
  await page.waitForSelector('text=backfill-old-events', { timeout: 15_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUTDIR, 'feature-board.png'), fullPage: false });
});

test('graph', async ({ page }) => {
  await gotoWorkflow(page);
  const graphTab = page.getByTestId('view-tab-graph');
  await graphTab.click();
  // Wait for an actual node to land in the React Flow viewport — the elkjs
  // layout pass is async and a fixed sleep races it on slower machines.
  await page.waitForSelector('.react-flow__node', { timeout: 15_000 });
  // Hide only the attribution badge — Controls + MiniMap are themed for dark
  // mode (GraphPane.tsx) and intentionally visible so the README shot matches
  // what users see live.
  await page.addStyleTag({
    content: `.react-flow__attribution { display: none !important; }`,
  });
  // Settle: extra beat for fitView + edge paint after nodes mount.
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUTDIR, 'graph.png'), fullPage: false });
});

test('attention-banner', async ({ page }) => {
  await gotoWorkflow(page);
  // The seeded pending_attention row renders inside the AttentionBanner region.
  // Use a locator screenshot so the banner fills the frame (otherwise it's a
  // thin strip lost in the rest of the dashboard).
  const banner = page.locator('[data-testid="attention-banner"]');
  await banner.waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForSelector('text=revisit_limit', { timeout: 15_000 });
  await page.waitForTimeout(500);
  await banner.screenshot({ path: path.join(OUTDIR, 'attention-banner.png') });
});

test('github-button', async ({ page }) => {
  await gotoWorkflow(page);
  // GithubButton renders the PR badge — wait for the PR number text.
  await page.waitForSelector('text=#42', { timeout: 15_000 }).catch(() => {
    // alternate copy: the button may render as "PR #42" or "Open PR #42"
    return page.waitForSelector('text=PR', { timeout: 5_000 });
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUTDIR, 'github-button.png'), fullPage: false });
});
