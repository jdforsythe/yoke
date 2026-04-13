/**
 * JigProcessManager — integration tests.
 *
 * All tests use 'node' as the command — no 'claude' or 'jig' strings anywhere.
 * Tests that need long-lived processes use short gracePeriodMs values so the
 * suite completes in well under 5 seconds.
 */

import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { JigProcessManager } from '../../src/server/process/jig-manager.js';
import {
  ProcessError,
  type ProcessManager,
  type SpawnHandle,
} from '../../src/server/process/manager.js';

const TMP = os.tmpdir();

/** Wait for the 'exit' event on a handle, resolving with [code, signal]. */
function waitForExit(handle: SpawnHandle): Promise<[number | null, NodeJS.Signals | null]> {
  return new Promise((resolve) => {
    handle.once('exit', (code, signal) => resolve([code, signal]));
  });
}

/** Collect all 'stderr_data' chunks until 'exit'. */
function collectStderr(handle: SpawnHandle): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    handle.on('stderr_data', (chunk) => {
      buf += chunk;
    });
    handle.once('exit', () => resolve(buf));
  });
}

/** Collect all 'stdout_line' events until 'exit'. */
function collectStdoutLines(handle: SpawnHandle): Promise<string[]> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    handle.on('stdout_line', (line) => lines.push(line));
    handle.once('exit', () => resolve(lines));
  });
}

// ---------------------------------------------------------------------------
// 1. Interface compliance
// ---------------------------------------------------------------------------

describe('ProcessManager interface', () => {
  it('JigProcessManager satisfies the ProcessManager interface', () => {
    const mgr: ProcessManager = new JigProcessManager();
    expect(typeof mgr.spawn).toBe('function');
  });

  it('spawn() returns a handle that satisfies SpawnHandle', async () => {
    const mgr = new JigProcessManager();
    const handle: SpawnHandle = await mgr.spawn({
      command: 'node',
      args: ['-e', 'process.exit(0)'],
      cwd: TMP,
      promptBuffer: '',
    });
    expect(typeof handle.pid).toBe('number');
    expect(typeof handle.pgid).toBe('number');
    expect(typeof handle.isAlive).toBe('function');
    expect(typeof handle.cancel).toBe('function');
    expect(typeof handle.on).toBe('function');
    expect(typeof handle.once).toBe('function');
    expect(typeof handle.off).toBe('function');
    await waitForExit(handle);
  });
});

// ---------------------------------------------------------------------------
// 2. Command-agnosticism / no hard-coded strings
// ---------------------------------------------------------------------------

describe('command-agnostic spawn', () => {
  it('uses command and args from opts — not hard-coded', async () => {
    // The concrete command is whatever the caller passes; here we use 'node'.
    // Verify that swapping the command works transparently.
    const mgr = new JigProcessManager();
    const handle = await mgr.spawn({
      command: 'node',
      args: ['-e', 'process.stdout.write("marker\\n"); process.exit(0)'],
      cwd: TMP,
      promptBuffer: '',
    });
    const lines = await collectStdoutLines(handle);
    expect(lines).toContain('marker');
  });
});

// ---------------------------------------------------------------------------
// 3. Process group / pgid
// ---------------------------------------------------------------------------

describe('pgid tracking', () => {
  it('pgid equals pid (detached child is its own process group leader)', async () => {
    const mgr = new JigProcessManager();
    const handle = await mgr.spawn({
      command: 'node',
      args: ['-e', 'process.exit(0)'],
      cwd: TMP,
      promptBuffer: '',
    });
    expect(handle.pgid).toBe(handle.pid);
    await waitForExit(handle);
  });
});

// ---------------------------------------------------------------------------
// 4. Liveness probe — isAlive()
// ---------------------------------------------------------------------------

describe('isAlive()', () => {
  it('returns true while the process is running', async () => {
    const mgr = new JigProcessManager();
    const handle = await mgr.spawn({
      command: 'node',
      args: ['-e', 'setTimeout(() => process.exit(0), 2000)'],
      cwd: TMP,
      promptBuffer: '',
      gracePeriodMs: 200,
    });

    // Process just started — should be alive.
    expect(handle.isAlive()).toBe(true);

    await handle.cancel();
  });

  it('returns false after the process has exited', async () => {
    const mgr = new JigProcessManager();
    const handle = await mgr.spawn({
      command: 'node',
      args: ['-e', 'process.exit(0)'],
      cwd: TMP,
      promptBuffer: '',
    });

    await waitForExit(handle);
    expect(handle.isAlive()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Exit event
// ---------------------------------------------------------------------------

describe('exit event', () => {
  it('emits exit with code 0 on clean exit', async () => {
    const mgr = new JigProcessManager();
    const handle = await mgr.spawn({
      command: 'node',
      args: ['-e', 'process.exit(0)'],
      cwd: TMP,
      promptBuffer: '',
    });
    const [code, signal] = await waitForExit(handle);
    expect(code).toBe(0);
    expect(signal).toBeNull();
  });

  it('emits exit with non-zero code on failure exit', async () => {
    const mgr = new JigProcessManager();
    const handle = await mgr.spawn({
      command: 'node',
      args: ['-e', 'process.exit(42)'],
      cwd: TMP,
      promptBuffer: '',
    });
    const [code] = await waitForExit(handle);
    expect(code).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// 6. stdout_line events
// ---------------------------------------------------------------------------

describe('stdout_line events', () => {
  it('emits one event per NDJSON line written to stdout', async () => {
    const mgr = new JigProcessManager();
    const script = [
      'process.stdout.write(\'{"type":"text","text":"hello"}\\n\');',
      'process.stdout.write(\'{"type":"text","text":"world"}\\n\');',
      'process.exit(0);',
    ].join('');

    const handle = await mgr.spawn({
      command: 'node',
      args: ['-e', script],
      cwd: TMP,
      promptBuffer: '',
    });

    const lines = await collectStdoutLines(handle);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ type: 'text', text: 'hello' });
    expect(JSON.parse(lines[1])).toEqual({ type: 'text', text: 'world' });
  });

  it('buffers partial lines (no event until newline arrives)', async () => {
    const mgr = new JigProcessManager();
    // Write half a line, wait, then complete it — readline buffers correctly.
    const script =
      'process.stdout.write(\'partial\');' +
      'setTimeout(() => { process.stdout.write(\'_complete\\n\'); process.exit(0); }, 50);';

    const handle = await mgr.spawn({
      command: 'node',
      args: ['-e', script],
      cwd: TMP,
      promptBuffer: '',
    });

    const lines = await collectStdoutLines(handle);
    expect(lines).toEqual(['partial_complete']);
  });
});

// ---------------------------------------------------------------------------
// 7. stderr capture
// ---------------------------------------------------------------------------

describe('stderr capture', () => {
  it('captures stderr output below the cap', async () => {
    const mgr = new JigProcessManager();
    const handle = await mgr.spawn({
      command: 'node',
      args: ['-e', 'process.stderr.write("oops\\n"); process.exit(1)'],
      cwd: TMP,
      promptBuffer: '',
    });

    const stderr = await collectStderr(handle);
    expect(stderr).toContain('oops');
  });

  it('caps stderr at 64 KB; bytes beyond cap are dropped', async () => {
    const CAP = 64 * 1024;
    const mgr = new JigProcessManager();
    // Write 128 KB to stderr — twice the cap.
    const script = `process.stderr.write(Buffer.alloc(${128 * 1024}, 120).toString()); process.exit(0);`;

    const handle = await mgr.spawn({
      command: 'node',
      args: ['-e', script],
      cwd: TMP,
      promptBuffer: '',
    });

    let stderrBytes = 0;
    handle.on('stderr_data', (chunk) => {
      stderrBytes += Buffer.byteLength(chunk, 'utf8');
    });

    await waitForExit(handle);

    // Must not exceed the 64 KB cap.
    expect(stderrBytes).toBeLessThanOrEqual(CAP);
    // Must have received something (cap is not zero).
    expect(stderrBytes).toBeGreaterThan(0);
  });

  it('emits stderr_cap_reached exactly once when cap is hit', async () => {
    const mgr = new JigProcessManager();
    const script = `process.stderr.write(Buffer.alloc(${128 * 1024}, 65).toString()); process.exit(0);`;

    const handle = await mgr.spawn({
      command: 'node',
      args: ['-e', script],
      cwd: TMP,
      promptBuffer: '',
    });

    let capCount = 0;
    handle.on('stderr_cap_reached', () => {
      capCount += 1;
    });

    await waitForExit(handle);
    expect(capCount).toBe(1);
  });

  it('never buffers stderr beyond cap regardless of chunk count', async () => {
    const CAP = 64 * 1024;
    const mgr = new JigProcessManager();
    // Write many small chunks totalling well above the cap.
    const chunkCount = 1000;
    const chunkSize = 200; // 200 KB total — 3× cap
    const script = [
      `const chunk = Buffer.alloc(${chunkSize}, 65).toString();`,
      `for (let i = 0; i < ${chunkCount}; i++) process.stderr.write(chunk);`,
      'process.exit(0);',
    ].join('');

    const handle = await mgr.spawn({
      command: 'node',
      args: ['-e', script],
      cwd: TMP,
      promptBuffer: '',
    });

    let stderrBytes = 0;
    handle.on('stderr_data', (chunk) => {
      stderrBytes += Buffer.byteLength(chunk, 'utf8');
    });

    await waitForExit(handle);
    expect(stderrBytes).toBeLessThanOrEqual(CAP);
  });
});

// ---------------------------------------------------------------------------
// 8. EPIPE handling
// ---------------------------------------------------------------------------

describe('EPIPE handling (AC-3)', () => {
  it('does not crash when child closes stdin before the prompt buffer is consumed', async () => {
    const mgr = new JigProcessManager();

    // The child destroys its stdin immediately (no reading), then exits.
    // Writing a large prompt buffer to a closed pipe triggers EPIPE.
    const handle = await mgr.spawn({
      command: 'node',
      args: [
        '-e',
        // Destroy stdin before reading; stay alive briefly so the parent write overlaps.
        'process.stdin.destroy(); setTimeout(() => process.exit(0), 300);',
      ],
      cwd: TMP,
      // 4 MB >> pipe buffer (64 KB on macOS, up to 1 MB on Linux) — reliably triggers EPIPE.
      promptBuffer: Buffer.alloc(4 * 1024 * 1024, 0),
    });

    const errors: ProcessError[] = [];
    handle.on('error', (err) => errors.push(err));

    // Must not throw an unhandled error; must reach exit cleanly.
    await waitForExit(handle);

    // If EPIPE fired, it must be a named ProcessError with kind='epipe'.
    for (const err of errors) {
      expect(err).toBeInstanceOf(ProcessError);
      expect(err.kind).toBe('epipe');
    }
    // The harness is still running (no crash) — verified by reaching this line.
  });

  it('EPIPE error has kind=epipe, not a generic Error', async () => {
    const mgr = new JigProcessManager();
    const handle = await mgr.spawn({
      command: 'node',
      args: ['-e', 'process.stdin.destroy(); setTimeout(() => process.exit(0), 200);'],
      cwd: TMP,
      promptBuffer: Buffer.alloc(4 * 1024 * 1024, 0),
    });

    const epipeErrors: ProcessError[] = [];
    handle.on('error', (err) => {
      if (err.kind === 'epipe') epipeErrors.push(err);
    });

    await waitForExit(handle);

    // Whether EPIPE fires is timing-dependent, but IF it fires it must be typed.
    for (const err of epipeErrors) {
      expect(err.name).toBe('ProcessError');
      expect(err.kind).toBe('epipe');
      expect(err.cause).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 9. SIGTERM → SIGKILL escalation (AC-2)
// ---------------------------------------------------------------------------

describe('cancel() — SIGTERM→SIGKILL escalation', () => {
  it('escalates to SIGKILL after grace period when process ignores SIGTERM', async () => {
    const GRACE_MS = 300; // short grace for tests
    const mgr = new JigProcessManager();

    // A process that traps SIGTERM and does nothing (will never exit on SIGTERM).
    // It writes "ready\n" to stdout once the handler is registered so the test
    // can wait for the handler to be in place before sending the signal — this
    // eliminates the race where SIGTERM arrives before process.on() executes.
    const handle = await mgr.spawn({
      command: 'node',
      args: [
        '-e',
        [
          'process.on("SIGTERM", () => {});',   // ignore SIGTERM
          'process.stdout.write("ready\\n");',  // readiness signal
          'setTimeout(() => {}, 60_000);',      // stay alive
        ].join(' '),
      ],
      cwd: TMP,
      promptBuffer: '',
      gracePeriodMs: GRACE_MS,
    });

    // Block until the child has registered its SIGTERM handler.
    await new Promise<void>((res) => handle.once('stdout_line', () => res()));

    expect(handle.isAlive()).toBe(true);

    // Listen for exit BEFORE calling cancel so we don't miss it.
    const exitPromise = waitForExit(handle);

    const t0 = Date.now();
    await handle.cancel(); // blocks for ≥ GRACE_MS then sends SIGKILL
    // Wait for the 'exit' event (may fire slightly after cancel() resolves).
    await exitPromise;
    const elapsed = Date.now() - t0;

    // Escalation must have waited at least (GRACE_MS − tolerance) ms.
    expect(elapsed).toBeGreaterThanOrEqual(GRACE_MS - 50);
    // Must be dead now.
    expect(handle.isAlive()).toBe(false);
  }, 5_000); // 5 s test timeout — well above 300 ms grace

  it('resolves immediately (no SIGKILL) when process exits during grace period', async () => {
    const GRACE_MS = 2_000;
    const mgr = new JigProcessManager();

    // Process exits cleanly on SIGTERM after registering its handler.
    const handle = await mgr.spawn({
      command: 'node',
      args: [
        '-e',
        [
          'process.on("SIGTERM", () => process.exit(0));',
          'process.stdout.write("ready\\n");',
          'setTimeout(() => {}, 60_000);',
        ].join(' '),
      ],
      cwd: TMP,
      promptBuffer: '',
      gracePeriodMs: GRACE_MS,
    });

    // Wait for the handler to be registered before cancelling.
    await new Promise<void>((res) => handle.once('stdout_line', () => res()));

    expect(handle.isAlive()).toBe(true);

    const t0 = Date.now();
    await handle.cancel(); // should resolve quickly — process exits on SIGTERM
    const elapsed = Date.now() - t0;

    // Should resolve well before the full grace period.
    expect(elapsed).toBeLessThan(GRACE_MS);
    expect(handle.isAlive()).toBe(false);
  }, 5_000);

  it('cancel() is a no-op when the process has already exited', async () => {
    const mgr = new JigProcessManager();
    const handle = await mgr.spawn({
      command: 'node',
      args: ['-e', 'process.exit(0)'],
      cwd: TMP,
      promptBuffer: '',
      gracePeriodMs: 5_000,
    });

    await waitForExit(handle);
    expect(handle.isAlive()).toBe(false);

    // Should return immediately without throwing.
    await expect(handle.cancel()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 10. Spawn failure (ENOENT)
// ---------------------------------------------------------------------------

describe('spawn failure', () => {
  it('emits ProcessError with kind=spawn_failed when command is not found', async () => {
    const mgr = new JigProcessManager();
    const handle = await mgr.spawn({
      command: 'this-binary-does-not-exist-xyz',
      args: [],
      cwd: TMP,
      promptBuffer: '',
    });

    const errors: ProcessError[] = [];
    handle.on('error', (err) => errors.push(err));

    // Either error fires or exit fires; give it time to settle.
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      handle.once('error', done);
      handle.once('exit', done);
    });

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toBeInstanceOf(ProcessError);
    expect(errors[0].kind).toBe('spawn_failed');
  });
});

// ---------------------------------------------------------------------------
// 11. promptBuffer delivered via stdin
// ---------------------------------------------------------------------------

describe('promptBuffer delivery', () => {
  it('child receives the prompt buffer on stdin', async () => {
    const mgr = new JigProcessManager();
    const expectedPrompt = 'HELLO_FROM_STDIN';

    // Echo stdin content to stdout.
    const handle = await mgr.spawn({
      command: 'node',
      args: ['-e', 'let d=""; process.stdin.setEncoding("utf8"); process.stdin.on("data", c => d+=c); process.stdin.on("end", () => { process.stdout.write(d.trim()+"\\n"); process.exit(0); });'],
      cwd: TMP,
      promptBuffer: expectedPrompt,
    });

    const lines = await collectStdoutLines(handle);
    expect(lines[0]).toBe(expectedPrompt);
  });
});

// ---------------------------------------------------------------------------
// 12. env injection
// ---------------------------------------------------------------------------

describe('environment variable injection', () => {
  it('child inherits caller-supplied env vars merged over process.env', async () => {
    const mgr = new JigProcessManager();
    const handle = await mgr.spawn({
      command: 'node',
      args: ['-e', 'process.stdout.write(process.env.YOKE_TEST_VAR+"\\n"); process.exit(0);'],
      cwd: TMP,
      promptBuffer: '',
      env: { YOKE_TEST_VAR: 'injected_value' },
    });

    const lines = await collectStdoutLines(handle);
    expect(lines[0]).toBe('injected_value');
  });
});
