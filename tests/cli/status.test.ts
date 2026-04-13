import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  resolveServerUrl,
  fetchWorkflows,
  formatWorkflowTable,
  type WorkflowRow,
} from '../../src/cli/status.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-status-test-'));
}
function removeTmpDir(d: string): void {
  fs.rmSync(d, { recursive: true, force: true });
}

const SAMPLE_WORKFLOWS: WorkflowRow[] = [
  { id: 'abc12345-0000-0000-0000-000000000001', name: 'feat-foo', status: 'running', current_stage: 'implement', active_sessions: 1 },
  { id: 'abc12345-0000-0000-0000-000000000002', name: 'feat-bar', status: 'complete', current_stage: null, active_sessions: 0 },
];

// ---------------------------------------------------------------------------
// resolveServerUrl
// ---------------------------------------------------------------------------

describe('resolveServerUrl()', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { removeTmpDir(tmpDir); });

  it('returns explicit URL when provided', () => {
    expect(resolveServerUrl('http://127.0.0.1:9999', tmpDir)).toBe('http://127.0.0.1:9999');
  });

  it('returns URL from server.json when present', () => {
    const yokeDir = path.join(tmpDir, '.yoke');
    fs.mkdirSync(yokeDir, { recursive: true });
    fs.writeFileSync(
      path.join(yokeDir, 'server.json'),
      JSON.stringify({ url: 'http://127.0.0.1:8888', pid: 123 }),
      'utf8',
    );
    expect(resolveServerUrl(undefined, tmpDir)).toBe('http://127.0.0.1:8888');
  });

  it('falls back to default when server.json absent', () => {
    expect(resolveServerUrl(undefined, tmpDir)).toBe('http://127.0.0.1:7777');
  });

  it('falls back to default when server.json is malformed', () => {
    const yokeDir = path.join(tmpDir, '.yoke');
    fs.mkdirSync(yokeDir, { recursive: true });
    fs.writeFileSync(path.join(yokeDir, 'server.json'), 'not-json', 'utf8');
    expect(resolveServerUrl(undefined, tmpDir)).toBe('http://127.0.0.1:7777');
  });

  it('explicit URL wins over server.json', () => {
    const yokeDir = path.join(tmpDir, '.yoke');
    fs.mkdirSync(yokeDir, { recursive: true });
    fs.writeFileSync(
      path.join(yokeDir, 'server.json'),
      JSON.stringify({ url: 'http://127.0.0.1:8888' }),
      'utf8',
    );
    expect(resolveServerUrl('http://127.0.0.1:1234', tmpDir)).toBe('http://127.0.0.1:1234');
  });
});

// ---------------------------------------------------------------------------
// fetchWorkflows — ECONNREFUSED handling
// ---------------------------------------------------------------------------

describe('fetchWorkflows()', () => {
  it('converts ECONNREFUSED to a human-readable error', async () => {
    const fakeError = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    const mockFetch = async () => { throw fakeError; };

    await expect(
      fetchWorkflows('http://127.0.0.1:19999', mockFetch as typeof fetch),
    ).rejects.toThrow(/Cannot connect to Yoke server/);
  });

  it('throws on non-ok HTTP response', async () => {
    const mockFetch = async () =>
      new Response('Internal Server Error', { status: 500 });
    await expect(
      fetchWorkflows('http://127.0.0.1:19999', mockFetch as typeof fetch),
    ).rejects.toThrow(/500/);
  });

  it('returns workflow list on 200', async () => {
    const body = { workflows: SAMPLE_WORKFLOWS, hasMore: false };
    const mockFetch = async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    const result = await fetchWorkflows('http://127.0.0.1:19999', mockFetch as typeof fetch);
    expect(result.workflows).toHaveLength(2);
    expect(result.workflows[0].id).toBe(SAMPLE_WORKFLOWS[0].id);
  });
});

// ---------------------------------------------------------------------------
// formatWorkflowTable
// ---------------------------------------------------------------------------

describe('formatWorkflowTable()', () => {
  it('prints "(no workflows)" when list is empty', () => {
    const table = formatWorkflowTable([]);
    expect(table).toContain('(no workflows)');
  });

  it('includes header columns', () => {
    const table = formatWorkflowTable([]);
    expect(table).toContain('ID');
    expect(table).toContain('NAME');
    expect(table).toContain('STATUS');
    expect(table).toContain('STAGE');
    expect(table).toContain('SESSIONS');
  });

  it('renders a row per workflow', () => {
    const table = formatWorkflowTable(SAMPLE_WORKFLOWS);
    // Truncated id (first 10 chars).
    expect(table).toContain('abc12345-0');
    expect(table).toContain('feat-foo');
    expect(table).toContain('running');
    expect(table).toContain('implement');
    expect(table).toContain('feat-bar');
    expect(table).toContain('complete');
  });

  it('shows — when current_stage is null', () => {
    const table = formatWorkflowTable(SAMPLE_WORKFLOWS);
    expect(table).toContain('—');
  });

  it('shows active_sessions count', () => {
    const table = formatWorkflowTable(SAMPLE_WORKFLOWS);
    // workflow[0] has 1 active session, workflow[1] has 0
    const lines = table.split('\n');
    // First data row (after header + separator)
    expect(lines[2]).toContain('1');
  });
});
