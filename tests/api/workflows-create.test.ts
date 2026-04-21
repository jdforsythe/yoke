/**
 * Tests for GET /api/templates and POST /api/workflows (t-07).
 *
 * Covers all acceptance criteria:
 *  - GET /api/templates returns {templates: [{name, description?}]} 200
 *  - GET /api/templates with no templates dir returns {templates: []} 200 (not 500)
 *  - GET /api/templates skips files with parse/validation errors
 *  - POST /api/workflows valid body → 201 {workflowId, name}
 *  - POST /api/workflows unknown templateName → 404
 *  - POST /api/workflows empty name → 400
 *  - POST /api/workflows broadcasts 'workflow.created' WS frame
 *  - POST /api/workflows returns sameTemplateNames for soft collision
 *
 * Uses real Fastify + real SQLite + real listTemplates/loadTemplate/createWorkflow
 * injected via ServerCallbacks so the full RC-3 path is exercised.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createServer,
  type ServerCallbacks,
  type ServerHandle,
  type CreateWorkflowResult,
} from '../../src/server/api/server.js';
import { openDbPool, type DbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';
import { listTemplates, loadTemplate } from '../../src/server/config/loader.js';
import { ConfigLoadError } from '../../src/server/config/errors.js';
import { createWorkflow } from '../../src/server/scheduler/ingest.js';
import type { ResolvedConfig } from '../../src/shared/types/config.js';

// ---------------------------------------------------------------------------
// Minimal valid template YAML for tests
// ---------------------------------------------------------------------------

const MINIMAL_TEMPLATE = `\
version: "1"
template:
  name: test-project
  description: A test template
pipeline:
  stages:
    - id: main
      run: once
      phases:
        - implement
phases:
  implement:
    command: claude
    args: []
    prompt_template: prompts/implement.md
`;

const TEMPLATE_NO_DESC = `\
version: "1"
template:
  name: no-desc-project
pipeline:
  stages:
    - id: main
      run: once
      phases:
        - implement
phases:
  implement:
    command: claude
    args: []
    prompt_template: prompts/implement.md
`;

const INVALID_YAML = `not: valid: yaml: [unclosed`;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: DbPool;
let handle: ServerHandle;
let callbacks: ServerCallbacks;

const migrationsDir = new URL(
  '../../src/server/storage/migrations/',
  import.meta.url,
).pathname;

function writeTemplate(content: string, name = 'default'): void {
  const dir = path.join(tmpDir, '.yoke', 'templates');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.yml`), content, 'utf8');
}

/** Build a createWorkflow callback that calls the real ingest functions. */
function makeCreateWorkflowCallback(configDir: string): ServerCallbacks['createWorkflow'] {
  return ({ templateName, name }): CreateWorkflowResult => {
    let config: ResolvedConfig;
    try {
      config = loadTemplate(configDir, templateName);
    } catch (err) {
      if (err instanceof ConfigLoadError) {
        if (err.detail.kind === 'not_found') return { status: 'template_not_found' };
        return { status: 'template_error', message: err.message };
      }
      throw err;
    }

    const { workflowId } = createWorkflow(db, config, { name });

    // template_name in the DB stores config.template.name (the YAML name), not the file name.
    const existingRows = db
      .reader()
      .prepare(
        'SELECT name FROM workflows WHERE template_name = ? AND id != ? ORDER BY created_at DESC',
      )
      .all(config.template.name, workflowId) as Array<{ name: string }>;

    return {
      status: 'created',
      workflowId,
      name,
      sameTemplateNames: existingRows.map((r) => r.name),
    };
  };
}

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yoke-t07-'));
  db = openDbPool(path.join(tmpDir, 'test.db'));
  applyMigrations(db.writer, migrationsDir);

  callbacks = {
    listTemplates: () => {
      try {
        return listTemplates(tmpDir).map((t) => ({ name: t.name, description: t.description }));
      } catch {
        return [];
      }
    },
    createWorkflow: makeCreateWorkflowCallback(tmpDir),
  };

  handle = await createServer(db, callbacks);
  await handle.fastify.ready();
});

afterEach(async () => {
  await handle.fastify.close();
  db.close();
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// GET /api/templates
// ---------------------------------------------------------------------------

describe('GET /api/templates', () => {
  it('returns {templates: []} 200 when no templates directory exists', async () => {
    const res = await handle.fastify.inject({ method: 'GET', url: '/api/templates' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { templates: unknown[] };
    expect(body.templates).toEqual([]);
  });

  it('returns {templates: []} 200 when directory is empty', async () => {
    fs.mkdirSync(path.join(tmpDir, '.yoke', 'templates'), { recursive: true });
    const res = await handle.fastify.inject({ method: 'GET', url: '/api/templates' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { templates: unknown[] };
    expect(body.templates).toEqual([]);
  });

  it('returns one entry with name and description for a valid template', async () => {
    writeTemplate(MINIMAL_TEMPLATE, 'default');
    const res = await handle.fastify.inject({ method: 'GET', url: '/api/templates' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { templates: Array<{ name: string; description: string | null }> };
    expect(body.templates).toHaveLength(1);
    expect(body.templates[0].name).toBe('default');
    expect(body.templates[0].description).toBe('A test template');
  });

  it('returns description: null for a template without description', async () => {
    writeTemplate(TEMPLATE_NO_DESC, 'nodesc');
    const res = await handle.fastify.inject({ method: 'GET', url: '/api/templates' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { templates: Array<{ name: string; description: string | null }> };
    expect(body.templates[0].description).toBeNull();
  });

  it('returns multiple templates when multiple files exist', async () => {
    writeTemplate(MINIMAL_TEMPLATE, 'alpha');
    writeTemplate(TEMPLATE_NO_DESC, 'beta');
    const res = await handle.fastify.inject({ method: 'GET', url: '/api/templates' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { templates: Array<{ name: string }> };
    expect(body.templates).toHaveLength(2);
    const names = body.templates.map((t) => t.name).sort();
    expect(names).toEqual(['alpha', 'beta']);
  });

  it('skips files with parse errors and returns the valid ones (never 500)', async () => {
    writeTemplate(MINIMAL_TEMPLATE, 'good');
    writeTemplate(INVALID_YAML, 'bad');
    const res = await handle.fastify.inject({ method: 'GET', url: '/api/templates' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { templates: Array<{ name: string }> };
    // Only the valid template is returned; bad is silently omitted.
    expect(body.templates).toHaveLength(1);
    expect(body.templates[0].name).toBe('good');
  });

  it('returns {templates: []} 200 (not 500) even when listTemplates is not configured', async () => {
    // Server without listTemplates callback
    const bare = await createServer(db, {});
    await bare.fastify.ready();
    try {
      const res = await bare.fastify.inject({ method: 'GET', url: '/api/templates' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { templates: unknown[] };
      expect(body.templates).toEqual([]);
    } finally {
      await bare.fastify.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/workflows — validation
// ---------------------------------------------------------------------------

describe('POST /api/workflows — validation errors', () => {
  it('returns 400 when templateName is missing', async () => {
    const res = await handle.fastify.inject({
      method: 'POST',
      url: '/api/workflows',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'My Workflow' }),
    });
    expect(res.statusCode).toBe(400);
    expect((JSON.parse(res.body) as { error: string }).error).toMatch(/templateName/i);
  });

  it('returns 400 when templateName is whitespace-only', async () => {
    const res = await handle.fastify.inject({
      method: 'POST',
      url: '/api/workflows',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateName: '   ', name: 'My Workflow' }),
    });
    expect(res.statusCode).toBe(400);
    expect((JSON.parse(res.body) as { error: string }).error).toMatch(/templateName/i);
  });

  it('returns 400 when name is missing', async () => {
    writeTemplate(MINIMAL_TEMPLATE, 'default');
    const res = await handle.fastify.inject({
      method: 'POST',
      url: '/api/workflows',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateName: 'default' }),
    });
    expect(res.statusCode).toBe(400);
    expect((JSON.parse(res.body) as { error: string }).error).toMatch(/name/i);
  });

  it('returns 400 when name is empty string', async () => {
    writeTemplate(MINIMAL_TEMPLATE, 'default');
    const res = await handle.fastify.inject({
      method: 'POST',
      url: '/api/workflows',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateName: 'default', name: '' }),
    });
    expect(res.statusCode).toBe(400);
    expect((JSON.parse(res.body) as { error: string }).error).toMatch(/non-empty/i);
  });

  it('returns 400 when name is whitespace-only', async () => {
    writeTemplate(MINIMAL_TEMPLATE, 'default');
    const res = await handle.fastify.inject({
      method: 'POST',
      url: '/api/workflows',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateName: 'default', name: '   ' }),
    });
    expect(res.statusCode).toBe(400);
    expect((JSON.parse(res.body) as { error: string }).error).toMatch(/non-empty/i);
  });

  it('returns 404 when templateName does not match an existing file', async () => {
    const res = await handle.fastify.inject({
      method: 'POST',
      url: '/api/workflows',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateName: 'nonexistent', name: 'My Workflow' }),
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toMatch(/nonexistent/);
    expect(body.error).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// POST /api/workflows — happy path
// ---------------------------------------------------------------------------

describe('POST /api/workflows — happy path', () => {
  it('returns 201 with workflowId and name on success', async () => {
    writeTemplate(MINIMAL_TEMPLATE, 'default');
    const res = await handle.fastify.inject({
      method: 'POST',
      url: '/api/workflows',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateName: 'default', name: 'My First Workflow' }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as {
      workflowId: string;
      name: string;
      sameTemplateNames: string[];
    };
    expect(typeof body.workflowId).toBe('string');
    expect(body.workflowId).toBeTruthy();
    expect(body.name).toBe('My First Workflow');
    expect(Array.isArray(body.sameTemplateNames)).toBe(true);
  });

  it('trims whitespace from name before storing', async () => {
    writeTemplate(MINIMAL_TEMPLATE, 'default');
    const res = await handle.fastify.inject({
      method: 'POST',
      url: '/api/workflows',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateName: 'default', name: '  trimmed  ' }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { name: string };
    expect(body.name).toBe('trimmed');
  });

  it('creates the workflow row in the DB', async () => {
    writeTemplate(MINIMAL_TEMPLATE, 'default');
    const res = await handle.fastify.inject({
      method: 'POST',
      url: '/api/workflows',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateName: 'default', name: 'DB Check' }),
    });
    expect(res.statusCode).toBe(201);
    const { workflowId } = JSON.parse(res.body) as { workflowId: string };

    const row = db.reader()
      .prepare('SELECT id, name, template_name, status FROM workflows WHERE id = ?')
      .get(workflowId) as { id: string; name: string; template_name: string; status: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.name).toBe('DB Check');
    // template_name stores the YAML template.name field ('test-project'), not the file name ('default').
    expect(row!.template_name).toBe('test-project');
    expect(row!.status).toBe('pending');
  });

  it('returns sameTemplateNames for existing workflows with the same template', async () => {
    writeTemplate(MINIMAL_TEMPLATE, 'default');

    // Create first workflow
    await handle.fastify.inject({
      method: 'POST',
      url: '/api/workflows',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateName: 'default', name: 'First' }),
    });

    // Create second workflow — should see 'First' in sameTemplateNames
    const res2 = await handle.fastify.inject({
      method: 'POST',
      url: '/api/workflows',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateName: 'default', name: 'Second' }),
    });
    expect(res2.statusCode).toBe(201);
    const body2 = JSON.parse(res2.body) as { sameTemplateNames: string[] };
    expect(body2.sameTemplateNames).toContain('First');
  });

  it('allows duplicate names (name uniqueness is not enforced)', async () => {
    writeTemplate(MINIMAL_TEMPLATE, 'default');

    const res1 = await handle.fastify.inject({
      method: 'POST',
      url: '/api/workflows',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateName: 'default', name: 'Dupe' }),
    });
    const res2 = await handle.fastify.inject({
      method: 'POST',
      url: '/api/workflows',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateName: 'default', name: 'Dupe' }),
    });
    expect(res1.statusCode).toBe(201);
    expect(res2.statusCode).toBe(201);

    // Both have distinct workflowIds.
    const id1 = (JSON.parse(res1.body) as { workflowId: string }).workflowId;
    const id2 = (JSON.parse(res2.body) as { workflowId: string }).workflowId;
    expect(id1).not.toBe(id2);

    // Second response includes the first workflow name in sameTemplateNames.
    const body2 = JSON.parse(res2.body) as { sameTemplateNames: string[] };
    expect(body2.sameTemplateNames).toContain('Dupe');
  });
});

// ---------------------------------------------------------------------------
// POST /api/workflows — WS broadcast
// ---------------------------------------------------------------------------

describe('POST /api/workflows — workflow.created broadcast', () => {
  it('broadcasts workflow.created to all connected WS clients on success', async () => {
    writeTemplate(MINIMAL_TEMPLATE, 'default');

    // Start listening so WS clients can connect.
    await handle.fastify.listen({ host: '127.0.0.1', port: 0 });
    const addr = handle.fastify.server.address() as AddressInfo;
    const wsUrl = `ws://127.0.0.1:${addr.port}/stream`;

    // Connect a WS client (no subscribe — broadcastAll sends to all clients).
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    // Collect the workflow.created frame with a timeout guard.
    const receivedCreated = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timeout: workflow.created not received within 2s')),
        2000,
      );
      ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg['type'] === 'workflow.created') {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });

    // POST to create the workflow (inject goes through the real route handler).
    const res = await handle.fastify.inject({
      method: 'POST',
      url: '/api/workflows',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateName: 'default', name: 'Broadcast Test' }),
    });
    expect(res.statusCode).toBe(201);

    const frame = await receivedCreated;
    expect(frame['type']).toBe('workflow.created');
    const payload = frame['payload'] as Record<string, unknown>;
    expect(payload['name']).toBe('Broadcast Test');
    expect(typeof payload['workflowId']).toBe('string');

    ws.close();
  });
});
