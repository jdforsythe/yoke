import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ScriptedProcessManager, parseFixture, CURRENT_FIXTURE_VERSION } from '../../src/server/process/scripted-manager.js';
import { StreamJsonParser } from '../../src/server/process/stream-json.js';

const FIXTURES_DIR = path.resolve(
  fileURLToPath(import.meta.url),
  '../../fixtures/scripted-manager',
);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-scripted-test-'));
}
function removeTmpDir(d: string): void {
  fs.rmSync(d, { recursive: true, force: true });
}

function writeFixture(dir: string, name: string, records: object[]): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return p;
}

/** Minimal SpawnOpts that satisfies the interface. */
const DUMMY_OPTS = {
  command: 'node',
  args: [],
  cwd: '/tmp',
  promptBuffer: '',
};

// ---------------------------------------------------------------------------
// parseFixture()
// ---------------------------------------------------------------------------

describe('parseFixture()', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { removeTmpDir(tmpDir); });

  it('parses stdout, stderr, and exit records', () => {
    const fixturePath = writeFixture(tmpDir, 'test.jsonl', [
      { type: 'stdout', line: '{"type":"text","text":"hello"}' },
      { type: 'stderr', chunk: 'warn: something\n' },
      { type: 'exit', code: 0 },
    ]);
    const records = parseFixture(fixturePath);
    expect(records).toHaveLength(3);
    expect(records[0]).toEqual({ type: 'stdout', line: '{"type":"text","text":"hello"}' });
    expect(records[1]).toEqual({ type: 'stderr', chunk: 'warn: something\n' });
    expect(records[2]).toEqual({ type: 'exit', code: 0 });
  });

  it('skips blank lines', () => {
    const p = path.join(tmpDir, 'blank.jsonl');
    fs.writeFileSync(p, '\n\n{"type":"exit","code":1}\n\n', 'utf8');
    const records = parseFixture(p);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({ type: 'exit', code: 1 });
  });

  it('skips malformed JSON lines', () => {
    const p = path.join(tmpDir, 'bad.jsonl');
    fs.writeFileSync(p, 'not-json\n{"type":"exit","code":0}\n', 'utf8');
    const records = parseFixture(p);
    expect(records).toHaveLength(1);
  });

  it('skips records with unknown type', () => {
    const p = path.join(tmpDir, 'unknown.jsonl');
    fs.writeFileSync(p, '{"type":"bogus","data":1}\n{"type":"exit","code":0}\n', 'utf8');
    const records = parseFixture(p);
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('exit');
  });

  it('returns empty array for empty file', () => {
    const p = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(p, '', 'utf8');
    expect(parseFixture(p)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ScriptedProcessManager — event replay
// ---------------------------------------------------------------------------

describe('ScriptedProcessManager', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { removeTmpDir(tmpDir); });

  it('emits stdout_line events in fixture order', async () => {
    const fixturePath = writeFixture(tmpDir, 'stdout.jsonl', [
      { type: 'stdout', line: 'line-1' },
      { type: 'stdout', line: 'line-2' },
      { type: 'exit', code: 0 },
    ]);
    const mgr = new ScriptedProcessManager({ fixturePath });
    const handle = await mgr.spawn(DUMMY_OPTS);

    const lines: string[] = [];
    handle.on('stdout_line', (l) => lines.push(l));

    await new Promise<void>((resolve) => handle.once('exit', () => resolve()));

    expect(lines).toEqual(['line-1', 'line-2']);
  });

  it('emits stderr_data events', async () => {
    const fixturePath = writeFixture(tmpDir, 'stderr.jsonl', [
      { type: 'stderr', chunk: 'err chunk' },
      { type: 'exit', code: 1 },
    ]);
    const mgr = new ScriptedProcessManager({ fixturePath });
    const handle = await mgr.spawn(DUMMY_OPTS);

    const chunks: string[] = [];
    handle.on('stderr_data', (c) => chunks.push(c));

    await new Promise<void>((resolve) => handle.once('exit', () => resolve()));
    expect(chunks).toEqual(['err chunk']);
  });

  it('emits exit with the fixture exit code', async () => {
    const fixturePath = writeFixture(tmpDir, 'exit.jsonl', [
      { type: 'exit', code: 42 },
    ]);
    const mgr = new ScriptedProcessManager({ fixturePath });
    const handle = await mgr.spawn(DUMMY_OPTS);

    const code = await new Promise<number | null>((resolve) =>
      handle.once('exit', (c) => resolve(c)),
    );
    expect(code).toBe(42);
  });

  it('emits implicit exit(0) when fixture has no exit record', async () => {
    const fixturePath = writeFixture(tmpDir, 'noexit.jsonl', [
      { type: 'stdout', line: 'only-output' },
    ]);
    const mgr = new ScriptedProcessManager({ fixturePath });
    const handle = await mgr.spawn(DUMMY_OPTS);

    const code = await new Promise<number | null>((resolve) =>
      handle.once('exit', (c) => resolve(c)),
    );
    expect(code).toBe(0);
  });

  it('provides a deterministic fake pid', async () => {
    const fixturePath = writeFixture(tmpDir, 'pid.jsonl', [
      { type: 'exit', code: 0 },
    ]);
    const mgr = new ScriptedProcessManager({ fixturePath });
    const handle = await mgr.spawn(DUMMY_OPTS);
    // pid is in the range 90000–99999 and stable for the same path.
    expect(handle.pid).toBeGreaterThanOrEqual(90000);
    expect(handle.pid).toBeLessThanOrEqual(99999);
    expect(handle.pid).toBe(handle.pgid);

    // Second spawn with same path returns same pid.
    const handle2 = await mgr.spawn(DUMMY_OPTS);
    expect(handle2.pid).toBe(handle.pid);

    // Wait for both to exit to avoid test leaks.
    await new Promise<void>((r) => handle.once('exit', () => r()));
    await new Promise<void>((r) => handle2.once('exit', () => r()));
  });

  it('honours explicit fakePid option', async () => {
    const fixturePath = writeFixture(tmpDir, 'fakepid.jsonl', [
      { type: 'exit', code: 0 },
    ]);
    const mgr = new ScriptedProcessManager({ fixturePath, fakePid: 12345 });
    const handle = await mgr.spawn(DUMMY_OPTS);
    expect(handle.pid).toBe(12345);
    await new Promise<void>((r) => handle.once('exit', () => r()));
  });

  it('isAlive() returns true before exit, false after', async () => {
    const fixturePath = writeFixture(tmpDir, 'alive.jsonl', [
      { type: 'exit', code: 0 },
    ]);
    const mgr = new ScriptedProcessManager({ fixturePath });
    const handle = await mgr.spawn(DUMMY_OPTS);

    expect(handle.isAlive()).toBe(true);
    await new Promise<void>((r) => handle.once('exit', () => r()));
    expect(handle.isAlive()).toBe(false);
  });

  it('cancel() emits exit with SIGTERM signal', async () => {
    const fixturePath = writeFixture(tmpDir, 'cancel.jsonl', [
      { type: 'stdout', line: 'long-running' },
      // No exit record — would loop forever without cancel.
      { type: 'exit', code: 0 },
    ]);
    const mgr = new ScriptedProcessManager({ fixturePath });
    const handle = await mgr.spawn(DUMMY_OPTS);

    // Register the exit listener BEFORE calling cancel().
    // cancel() resolves before the exit event fires (per SpawnHandle contract),
    // so we must await the exit event separately.
    const exitSignal = new Promise<NodeJS.Signals | null>((resolve) =>
      handle.once('exit', (_code, sig) => resolve(sig)),
    );

    await handle.cancel();
    const signal = await exitSignal;

    expect(signal).toBe('SIGTERM');
    expect(handle.isAlive()).toBe(false);
  });

  it('replays mixed stdout + stderr + exit in order', async () => {
    const fixturePath = writeFixture(tmpDir, 'mixed.jsonl', [
      { type: 'stdout', line: 'out-1' },
      { type: 'stderr', chunk: 'err-1' },
      { type: 'stdout', line: 'out-2' },
      { type: 'exit', code: 0 },
    ]);
    const mgr = new ScriptedProcessManager({ fixturePath });
    const handle = await mgr.spawn(DUMMY_OPTS);

    const events: string[] = [];
    handle.on('stdout_line', (l) => events.push(`out:${l}`));
    handle.on('stderr_data', (c) => events.push(`err:${c}`));

    await new Promise<void>((r) => handle.once('exit', () => r()));

    expect(events).toEqual(['out:out-1', 'err:err-1', 'out:out-2']);
  });
});

// ---------------------------------------------------------------------------
// parseFixture() — version header (AC-5)
// ---------------------------------------------------------------------------

describe('parseFixture() — version header', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { removeTmpDir(tmpDir); });

  it('accepts a fixture with a valid version-1 header', () => {
    const p = path.join(tmpDir, 'versioned.jsonl');
    fs.writeFileSync(
      p,
      [
        JSON.stringify({ type: 'header', version: CURRENT_FIXTURE_VERSION }),
        JSON.stringify({ type: 'exit', code: 0 }),
      ].join('\n') + '\n',
      'utf8',
    );
    const records = parseFixture(p);
    // Header is consumed, not returned.
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({ type: 'exit', code: 0 });
  });

  it('throws on an unknown version number', () => {
    const p = path.join(tmpDir, 'future.jsonl');
    fs.writeFileSync(
      p,
      JSON.stringify({ type: 'header', version: 99 }) + '\n',
      'utf8',
    );
    expect(() => parseFixture(p)).toThrow('Unsupported fixture version: 99 (expected 1)');
  });

  it('throws when version is a string instead of a number', () => {
    const p = path.join(tmpDir, 'strver.jsonl');
    fs.writeFileSync(
      p,
      JSON.stringify({ type: 'header', version: '1' }) + '\n',
      'utf8',
    );
    expect(() => parseFixture(p)).toThrow('Unsupported fixture version:');
  });

  it('accepts a fixture with no header (backward compat)', () => {
    const p = path.join(tmpDir, 'noheader.jsonl');
    fs.writeFileSync(
      p,
      JSON.stringify({ type: 'exit', code: 0 }) + '\n',
      'utf8',
    );
    const records = parseFixture(p);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({ type: 'exit', code: 0 });
  });
});

// ---------------------------------------------------------------------------
// Failure-mode fixtures (AC-3, RC-4)
// Tests verify each fixture file replays correctly via ScriptedProcessManager.
// Fixture names map to failure-mode rows in plan-draft3 §D35.
// ---------------------------------------------------------------------------

const DUMMY_OPTS_FM = {
  command: 'claude',
  args: [],
  cwd: '/tmp',
  promptBuffer: '',
};

describe('failure-mode fixtures', () => {
  it('session-ok: exits 0 and emits stdout lines', async () => {
    const mgr = new ScriptedProcessManager({
      fixturePath: path.join(FIXTURES_DIR, 'session-ok.jsonl'),
    });
    const handle = await mgr.spawn(DUMMY_OPTS_FM);
    const lines: string[] = [];
    handle.on('stdout_line', (l) => lines.push(l));
    const code = await new Promise<number | null>((r) =>
      handle.once('exit', (c) => r(c)),
    );
    expect(code).toBe(0);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('nonzero-exit-transient: exits 1 and emits transient-pattern stderr', async () => {
    const mgr = new ScriptedProcessManager({
      fixturePath: path.join(FIXTURES_DIR, 'nonzero-exit-transient.jsonl'),
    });
    const handle = await mgr.spawn(DUMMY_OPTS_FM);
    const stderrChunks: string[] = [];
    handle.on('stderr_data', (c) => stderrChunks.push(c));
    const code = await new Promise<number | null>((r) =>
      handle.once('exit', (c) => r(c)),
    );
    expect(code).toBe(1);
    const combined = stderrChunks.join('');
    // ECONNRESET is the canonical transient-error pattern in this fixture.
    expect(combined).toContain('ECONNRESET');
  });

  it('nonzero-exit-permanent: exits 1 and emits permanent-pattern stderr', async () => {
    const mgr = new ScriptedProcessManager({
      fixturePath: path.join(FIXTURES_DIR, 'nonzero-exit-permanent.jsonl'),
    });
    const handle = await mgr.spawn(DUMMY_OPTS_FM);
    const stderrChunks: string[] = [];
    handle.on('stderr_data', (c) => stderrChunks.push(c));
    const code = await new Promise<number | null>((r) =>
      handle.once('exit', (c) => r(c)),
    );
    expect(code).toBe(1);
    const combined = stderrChunks.join('');
    // "Cannot find module" is the canonical permanent-error pattern in this fixture.
    expect(combined).toContain('Cannot find module');
  });

  it('rate-limit-mid-stream: rate_limit_detected event fired via StreamJsonParser', async () => {
    const fixturePath = path.join(FIXTURES_DIR, 'rate-limit-mid-stream.jsonl');
    const mgr = new ScriptedProcessManager({ fixturePath });
    const handle = await mgr.spawn(DUMMY_OPTS_FM);

    const parser = new StreamJsonParser();
    const rateLimitEvents: Array<{ resetAt?: number }> = [];
    parser.on('rate_limit_detected', (ev) => rateLimitEvents.push(ev));
    handle.on('stdout_line', (line) => parser.feed(line));

    await new Promise<void>((r) => handle.once('exit', () => r()));

    expect(rateLimitEvents).toHaveLength(1);
    // The fixture encodes a far-future resetsAt so parsers can extract it.
    expect(rateLimitEvents[0]!.resetAt).toBeTypeOf('number');
  });
});
