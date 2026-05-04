/**
 * Playwright capture script — three dashboard screenshots used by the README
 * + docs/recipes pages.
 *
 * It boots an ephemeral yoke server against a fresh tmpdir running the
 * scenario-a fixture, takes the picker screenshot, then creates a workflow
 * via POST /api/workflows and lets it run for ~10 s before grabbing the
 * live-stream and review-panel screenshots. Total wall time ≈ 60 s.
 *
 * Run with:
 *   npx playwright test scripts/e2e/capture/dashboard.spec.ts
 *
 * Outputs:
 *   docs/img/picker.png
 *   docs/img/live-stream.png
 *   docs/img/review-panel.png
 */

import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const PORT = parseInt(process.env.YOKE_CAPTURE_PORT ?? '7792', 10);
const FIXTURE = path.join(REPO_ROOT, 'scripts/e2e/fixtures/scenario-a');
const OUTDIR = path.join(REPO_ROOT, 'docs', 'img');
const BASE_URL = `http://127.0.0.1:${PORT}`;

let yokePid: number | null = null;
let tmpdir: string | null = null;

async function waitForYoke(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE_URL}/api/templates`);
      if (r.ok) return;
    } catch {
      // pre-listen
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('yoke did not become ready within 30s');
}

test.beforeAll(async () => {
  // Use the existing setup-tmpdir.sh helper so the seed/git logic stays in
  // one place.
  const setup = path.join(REPO_ROOT, 'scripts/e2e/lib/setup-tmpdir.sh');
  tmpdir = execFileSync('bash', [setup, FIXTURE], { encoding: 'utf8' }).trim();

  const yokeBin = path.join(REPO_ROOT, 'bin/yoke');
  const child: ChildProcess = spawn(
    yokeBin,
    ['start', '--template', 'scenario-a', '--port', String(PORT), '--config-dir', tmpdir],
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
      // best-effort
    }
    await new Promise((r) => setTimeout(r, 2_000));
    try {
      process.kill(yokePid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  if (tmpdir && existsSync(tmpdir) && process.env.YOKE_CAPTURE_KEEP !== '1') {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('dashboard: picker', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  // Empty-state landing should show the create-workflow / template picker.
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUTDIR, 'picker.png'), fullPage: false });
});

test('dashboard: live-stream', async ({ page }) => {
  // Start a workflow so the dashboard has something live to render.
  const create = await fetch(`${BASE_URL}/api/workflows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ templateName: 'scenario-a', name: 'capture-live' }),
  });
  expect(create.status).toBe(201);
  const { workflowId } = (await create.json()) as { workflowId: string };
  expect(workflowId).toBeTruthy();

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${BASE_URL}/workflow/${workflowId}`, { waitUntil: 'networkidle' });
  // Let the first phase actually start streaming output.
  await page.waitForTimeout(8_000);
  await page.screenshot({ path: path.join(OUTDIR, 'live-stream.png'), fullPage: false });
});

test('dashboard: item-detail', async ({ page }) => {
  // Capture the right-pane "session" view by clicking into a workflow
  // item once one is visible. We start a fresh workflow, wait long enough
  // for the planner item to appear, then click it. This shows the full
  // three-pane layout (sidebar + items list + live session pane).
  const create = await fetch(`${BASE_URL}/api/workflows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ templateName: 'scenario-a', name: 'capture-detail' }),
  });
  expect(create.status).toBe(201);
  const { workflowId } = (await create.json()) as { workflowId: string };

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${BASE_URL}/workflow/${workflowId}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(6_000);

  // Click the first item row in the centre column. The dashboard uses an
  // expandable triangle ▶︎ on each item card. Targeting the in_progress
  // status badge area lands on the row reliably.
  const firstItem = page.locator('text=in_progress').first();
  if ((await firstItem.count()) > 0) {
    await firstItem.click({ trial: false }).catch(() => {});
    await page.waitForTimeout(4_000);
  } else {
    await page.waitForTimeout(6_000);
  }
  await page.screenshot({ path: path.join(OUTDIR, 'item-detail.png'), fullPage: false });
});
