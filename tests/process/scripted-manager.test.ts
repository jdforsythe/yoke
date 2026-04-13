import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ScriptedProcessManager, parseFixture } from '../../src/server/process/scripted-manager.js';

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
    await new Promise<void>((r) => handle.once('exit', r));
    await new Promise<void>((r) => handle2.once('exit', r));
  });

  it('honours explicit fakePid option', async () => {
    const fixturePath = writeFixture(tmpDir, 'fakepid.jsonl', [
      { type: 'exit', code: 0 },
    ]);
    const mgr = new ScriptedProcessManager({ fixturePath, fakePid: 12345 });
    const handle = await mgr.spawn(DUMMY_OPTS);
    expect(handle.pid).toBe(12345);
    await new Promise<void>((r) => handle.once('exit', r));
  });

  it('isAlive() returns true before exit, false after', async () => {
    const fixturePath = writeFixture(tmpDir, 'alive.jsonl', [
      { type: 'exit', code: 0 },
    ]);
    const mgr = new ScriptedProcessManager({ fixturePath });
    const handle = await mgr.spawn(DUMMY_OPTS);

    expect(handle.isAlive()).toBe(true);
    await new Promise<void>((r) => handle.once('exit', r));
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

    await new Promise<void>((r) => handle.once('exit', r));

    expect(events).toEqual(['out:out-1', 'err:err-1', 'out:out-2']);
  });
});
