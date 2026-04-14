import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FixtureWriter } from '../../src/server/process/fixture-writer.js';
import { parseFixture, CURRENT_FIXTURE_VERSION } from '../../src/server/process/scripted-manager.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-fixture-writer-test-'));
}
function removeTmpDir(d: string): void {
  fs.rmSync(d, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// FixtureWriter
// ---------------------------------------------------------------------------

describe('FixtureWriter', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { removeTmpDir(tmpDir); });

  it('open() creates parent directories and writes a version header', () => {
    const capturePath = path.join(tmpDir, 'deep', 'nested', 'capture.jsonl');
    const writer = new FixtureWriter({ capturePath });

    writer.open();

    expect(fs.existsSync(capturePath)).toBe(true);
    const lines = fs.readFileSync(capturePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const header = JSON.parse(lines[0]!);
    expect(header).toEqual({ type: 'header', version: CURRENT_FIXTURE_VERSION });
  });

  it('throws if open() is called twice', () => {
    const writer = new FixtureWriter({ capturePath: path.join(tmpDir, 'x.jsonl') });
    writer.open();
    expect(() => writer.open()).toThrow('open() already called');
  });

  it('appendStdout writes a stdout record', () => {
    const capturePath = path.join(tmpDir, 'out.jsonl');
    const writer = new FixtureWriter({ capturePath });
    writer.open();
    writer.appendStdout('{"type":"text","text":"hello"}');
    writer.close(0);

    const records = parseFixture(capturePath);
    expect(records).toContainEqual({ type: 'stdout', line: '{"type":"text","text":"hello"}' });
  });

  it('appendStderr writes a stderr record', () => {
    const capturePath = path.join(tmpDir, 'err.jsonl');
    const writer = new FixtureWriter({ capturePath });
    writer.open();
    writer.appendStderr('warn: something\n');
    writer.close(0);

    const records = parseFixture(capturePath);
    expect(records).toContainEqual({ type: 'stderr', chunk: 'warn: something\n' });
  });

  it('close() writes an exit record with the given code', () => {
    const capturePath = path.join(tmpDir, 'exit.jsonl');
    const writer = new FixtureWriter({ capturePath });
    writer.open();
    writer.close(42);

    const records = parseFixture(capturePath);
    const exitRec = records.find((r) => r.type === 'exit');
    expect(exitRec).toEqual({ type: 'exit', code: 42 });
  });

  it('close(null) writes exit code -1', () => {
    const capturePath = path.join(tmpDir, 'sigkill.jsonl');
    const writer = new FixtureWriter({ capturePath });
    writer.open();
    writer.close(null);

    const records = parseFixture(capturePath);
    const exitRec = records.find((r) => r.type === 'exit');
    expect(exitRec).toEqual({ type: 'exit', code: -1 });
  });

  it('records are written in emission order (header, stdout, stderr, exit)', () => {
    const capturePath = path.join(tmpDir, 'ordered.jsonl');
    const writer = new FixtureWriter({ capturePath });
    writer.open();
    writer.appendStdout('line-1');
    writer.appendStderr('err-1');
    writer.appendStdout('line-2');
    writer.close(0);

    const records = parseFixture(capturePath);
    expect(records.map((r) => r.type)).toEqual(['stdout', 'stderr', 'stdout', 'exit']);
  });

  it('appendStdout after close() is a no-op (no throw)', () => {
    const capturePath = path.join(tmpDir, 'noop.jsonl');
    const writer = new FixtureWriter({ capturePath });
    writer.open();
    writer.close(0);
    // Must not throw.
    expect(() => writer.appendStdout('late')).not.toThrow();

    const records = parseFixture(capturePath);
    expect(records.find((r) => r.type === 'stdout')).toBeUndefined();
  });

  it('close() is idempotent — second call is a no-op', () => {
    const capturePath = path.join(tmpDir, 'idempotent.jsonl');
    const writer = new FixtureWriter({ capturePath });
    writer.open();
    writer.close(0);
    expect(() => writer.close(1)).not.toThrow();

    const records = parseFixture(capturePath);
    const exitRecs = records.filter((r) => r.type === 'exit');
    expect(exitRecs).toHaveLength(1); // Only one exit record.
  });

  it('stderr cap: chunks exceeding the cap are silently dropped', () => {
    const capturePath = path.join(tmpDir, 'cap.jsonl');
    const writer = new FixtureWriter({ capturePath, stderrCapBytes: 10 });
    writer.open();
    // First 10-byte chunk fits exactly.
    writer.appendStderr('0123456789');
    // Next chunk would exceed cap — dropped.
    writer.appendStderr('overflow');
    writer.close(0);

    const records = parseFixture(capturePath);
    const stderrRecs = records.filter((r) => r.type === 'stderr');
    expect(stderrRecs).toHaveLength(1);
    expect(stderrRecs[0]).toEqual({ type: 'stderr', chunk: '0123456789' });
  });

  it('isOpen returns true after open(), false after close()', () => {
    const capturePath = path.join(tmpDir, 'isopen.jsonl');
    const writer = new FixtureWriter({ capturePath });
    expect(writer.isOpen).toBe(false);
    writer.open();
    expect(writer.isOpen).toBe(true);
    writer.close(0);
    expect(writer.isOpen).toBe(false);
  });

  it('produces a fixture parseable and replayable by ScriptedProcessManager', async () => {
    const { ScriptedProcessManager } = await import('../../src/server/process/scripted-manager.js');

    const capturePath = path.join(tmpDir, 'replay.jsonl');
    const writer = new FixtureWriter({ capturePath });
    writer.open();
    writer.appendStdout('line-A');
    writer.appendStdout('line-B');
    writer.appendStderr('err-chunk');
    writer.close(0);

    // Replay via ScriptedProcessManager.
    const mgr = new ScriptedProcessManager({ fixturePath: capturePath });
    const handle = await mgr.spawn({ command: 'node', args: [], cwd: '/tmp', promptBuffer: '' });

    const stdoutLines: string[] = [];
    const stderrChunks: string[] = [];
    handle.on('stdout_line', (l) => stdoutLines.push(l));
    handle.on('stderr_data', (c) => stderrChunks.push(c));

    const exitCode = await new Promise<number | null>((r) =>
      handle.once('exit', (code) => r(code)),
    );

    expect(exitCode).toBe(0);
    expect(stdoutLines).toEqual(['line-A', 'line-B']);
    expect(stderrChunks).toEqual(['err-chunk']);
  });
});
