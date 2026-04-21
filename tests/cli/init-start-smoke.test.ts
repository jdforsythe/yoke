/**
 * Smoke test: yoke init → yoke start → GET /api/templates
 *
 * Verifies the end-to-end flow described in the templates refactor (t-10):
 *   1. yoke init creates .yoke/templates/default.yml in a fresh directory.
 *   2. yoke start loads that template without error.
 *   3. GET /api/templates returns one template named "default".
 *   4. GET /api/workflows returns an empty list (no workflows yet).
 *
 * Uses the same helpers as start.test.ts (noopGitCheck, port 0).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runInit } from '../../src/cli/init.js';
import { startServer, type StartHandle } from '../../src/cli/start.js';

const noopGitCheck = async (_dir: string): Promise<void> => { /* bypass git check in tests */ };

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-smoke-test-'));
}

function removeTmpDir(d: string): void {
  fs.rmSync(d, { recursive: true, force: true });
}

describe('yoke init → yoke start smoke test', () => {
  let tmpDir: string;
  let handle: StartHandle | undefined;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
    removeTmpDir(tmpDir);
  });

  it('init creates default.yml; start loads it; /api/templates returns one template', async () => {
    // Step 1: yoke init
    const initResult = runInit(tmpDir);
    expect(initResult.ok).toBe(true);

    // The default.yml file must exist under .yoke/templates/
    const defaultYml = path.join(tmpDir, '.yoke', 'templates', 'default.yml');
    expect(fs.existsSync(defaultYml)).toBe(true);

    // Step 2: yoke start (noScheduler so no items advance; port 0 for OS-assigned port)
    handle = await startServer({
      configDir: tmpDir,
      port: 0,
      noScheduler: true,
      _gitCheck: noopGitCheck,
    });

    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // Step 3: GET /api/templates → one template named "default"
    const templatesRes = await fetch(`${handle.url}/api/templates`);
    expect(templatesRes.status).toBe(200);
    const templatesBody = (await templatesRes.json()) as {
      templates: Array<{ name: string; description: string | null }>;
    };
    expect(Array.isArray(templatesBody.templates)).toBe(true);
    expect(templatesBody.templates).toHaveLength(1);
    expect(templatesBody.templates[0].name).toBe('default');

    // Step 4: GET /api/workflows → empty list (no workflows created yet)
    const workflowsRes = await fetch(`${handle.url}/api/workflows`);
    expect(workflowsRes.status).toBe(200);
    const workflowsBody = (await workflowsRes.json()) as { workflows: unknown[] };
    expect(Array.isArray(workflowsBody.workflows)).toBe(true);
    expect(workflowsBody.workflows).toHaveLength(0);
  });

  it('init output file contains template: key and valid version', () => {
    runInit(tmpDir);
    const content = fs.readFileSync(
      path.join(tmpDir, '.yoke', 'templates', 'default.yml'),
      'utf8',
    );
    expect(content).toContain('version: "1"');
    expect(content).toContain('template:');
    expect(content).not.toContain('project:');
  });
});
