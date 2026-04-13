/**
 * Pre/Post Command Runner — integration tests.
 *
 * All tests use 'node' as the command — no 'claude', 'jig', or other
 * hard-coded program names.
 *
 * Tests use a real tmpdir, a real SessionLogWriter, and real child processes.
 * Test timeouts are generous (10 s) to allow for CI scheduling jitter.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrePostCommand } from '../../src/shared/types/config.js';
import { runCommands } from '../../src/server/prepost/runner.js';
import { SessionLogWriter } from '../../src/server/session-log/writer.js';

let tmpDir: string;
let logPath: string;
let logWriter: SessionLogWriter;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yoke-prepost-'));
  logPath = path.join(tmpDir, 'session.jsonl');
  logWriter = new SessionLogWriter(logPath);
  await logWriter.open();
});

afterEach(async () => {
  await logWriter.close();
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read all JSONL frames from the log file. */
async function readFrames(): Promise<Record<string, unknown>[]> {
  const content = await fs.promises.readFile(logPath, 'utf8');
  return content
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Build a minimal PrePostCommand with exit-0-continue. */
function cmd(
  name: string,
  run: string[],
  overrides?: Partial<PrePostCommand>,
): PrePostCommand {
  return {
    name,
    run,
    actions: { '0': 'continue', '*': { fail: { reason: 'unexpected exit' } } },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Complete — all commands exit 0 with continue
// ---------------------------------------------------------------------------

describe('runCommands — complete path', () => {
  it('returns { kind: complete } when a single command exits 0 with continue', async () => {
    const result = await runCommands({
      commands: [cmd('echo', ['node', '-e', 'process.exit(0)'])],
      worktreePath: tmpDir,
      logWriter,
      when: 'post',
    });
    expect(result.kind).toBe('complete');
    expect(result.runs).toHaveLength(1);
  });

  it('returns { kind: complete } when multiple commands all exit 0 with continue', async () => {
    const result = await runCommands({
      commands: [
        cmd('cmd1', ['node', '-e', 'process.exit(0)']),
        cmd('cmd2', ['node', '-e', 'process.exit(0)']),
        cmd('cmd3', ['node', '-e', 'process.exit(0)']),
      ],
      worktreePath: tmpDir,
      logWriter,
      when: 'pre',
    });
    expect(result.kind).toBe('complete');
    expect(result.runs).toHaveLength(3);
  });

  it('returns { kind: complete } for an empty commands array', async () => {
    const result = await runCommands({
      commands: [],
      worktreePath: tmpDir,
      logWriter,
      when: 'pre',
    });
    expect(result.kind).toBe('complete');
    expect(result.runs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Action — non-continue action returned
// ---------------------------------------------------------------------------

describe('runCommands — action returned', () => {
  it('returns { kind: action } when first command exits with a non-continue action', async () => {
    const command = cmd('check', ['node', '-e', 'process.exit(1)'], {
      actions: { '0': 'continue', '1': { goto: 'plan' }, '*': { fail: { reason: 'unexpected' } } },
    });
    const result = await runCommands({
      commands: [command],
      worktreePath: tmpDir,
      logWriter,
      when: 'post',
    });
    expect(result).toMatchObject({ kind: 'action', command: 'check', action: { goto: 'plan' } });
    expect(result.runs).toHaveLength(1);
  });

  it('stops at the first failing command and does not run subsequent commands', async () => {
    const ran: string[] = [];
    // We can't inject a side-effect easily, so we use a flag file instead.
    const flagFile = path.join(tmpDir, 'ran-cmd2');
    const result = await runCommands({
      commands: [
        cmd('cmd1', ['node', '-e', 'process.exit(1)'], {
          actions: { '1': 'stop-and-ask', '*': 'stop' },
        }),
        cmd('cmd2', ['node', '-e',
          `require('fs').writeFileSync(${JSON.stringify(flagFile)}, '1'); process.exit(0);`]),
      ],
      worktreePath: tmpDir,
      logWriter,
      when: 'post',
    });
    expect(result).toMatchObject({ kind: 'action', command: 'cmd1', action: 'stop-and-ask' });
    // cmd2 must not have run.
    const flagExists = await fs.promises.access(flagFile).then(() => true).catch(() => false);
    expect(flagExists).toBe(false);
  });

  it('runs the first command and stops at the second when second returns non-continue', async () => {
    const result = await runCommands({
      commands: [
        cmd('first', ['node', '-e', 'process.exit(0)']),
        cmd('second', ['node', '-e', 'process.exit(1)'], {
          actions: { '0': 'continue', '1': 'stop' },
        }),
      ],
      worktreePath: tmpDir,
      logWriter,
      when: 'post',
    });
    expect(result).toMatchObject({ kind: 'action', command: 'second', action: 'stop' });
  });

  it('returns stop-and-ask action correctly', async () => {
    const result = await runCommands({
      commands: [
        cmd('check', ['node', '-e', 'process.exit(2)'], {
          actions: { '2': 'stop-and-ask' },
        }),
      ],
      worktreePath: tmpDir,
      logWriter,
      when: 'pre',
    });
    expect(result).toMatchObject({ kind: 'action', command: 'check', action: 'stop-and-ask' });
  });

  it('wildcard action is returned for an undeclared exit code', async () => {
    const result = await runCommands({
      commands: [
        cmd('check', ['node', '-e', 'process.exit(99)'], {
          actions: { '0': 'continue', '*': { fail: { reason: 'oops' } } },
        }),
      ],
      worktreePath: tmpDir,
      logWriter,
      when: 'post',
    });
    expect(result).toMatchObject({ kind: 'action', command: 'check', action: { fail: { reason: 'oops' } } });
  });
});

// ---------------------------------------------------------------------------
// 3. Unhandled exit code
// ---------------------------------------------------------------------------

describe('runCommands — unhandled exit code', () => {
  it('returns { kind: unhandled_exit } when exit code has no matching action', async () => {
    const result = await runCommands({
      commands: [
        cmd('check', ['node', '-e', 'process.exit(42)'], {
          actions: { '0': 'continue' }, // no "42" and no "*"
        }),
      ],
      worktreePath: tmpDir,
      logWriter,
      when: 'post',
    });
    expect(result).toMatchObject({ kind: 'unhandled_exit', command: 'check', exitCode: 42 });
  });
});

// ---------------------------------------------------------------------------
// 4. Spawn failure
// ---------------------------------------------------------------------------

describe('runCommands — spawn failure', () => {
  it('returns { kind: spawn_failed } when the command binary does not exist', async () => {
    const result = await runCommands({
      commands: [
        cmd('missing', ['this-binary-does-not-exist-xyz-yoke-test'], {
          actions: { '0': 'continue', '*': 'stop' },
        }),
      ],
      worktreePath: tmpDir,
      logWriter,
      when: 'post',
    });
    expect(result.kind).toBe('spawn_failed');
    if (result.kind === 'spawn_failed') {
      expect(result.command).toBe('missing');
      expect(result.error).toBeInstanceOf(Error);
    }
  });

  it('returns { kind: spawn_failed } when run array is empty', async () => {
    const result = await runCommands({
      commands: [
        { name: 'empty', run: [], actions: { '0': 'continue' } },
      ],
      worktreePath: tmpDir,
      logWriter,
      when: 'pre',
    });
    expect(result.kind).toBe('spawn_failed');
    if (result.kind === 'spawn_failed') {
      expect(result.command).toBe('empty');
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Session log frames (AC-2)
// ---------------------------------------------------------------------------

describe('session log frames (AC-2)', () => {
  it('writes prepost.command.start frame before the command runs', async () => {
    await runCommands({
      commands: [cmd('my-cmd', ['node', '-e', 'process.exit(0)'])],
      worktreePath: tmpDir,
      logWriter,
      when: 'post',
    });

    const frames = await readFrames();
    const startFrame = frames.find((f) => f['type'] === 'prepost.command.start');
    expect(startFrame).toBeDefined();
    expect(startFrame!['name']).toBe('my-cmd');
    expect(startFrame!['when']).toBe('post');
    expect(startFrame!['cmd']).toEqual(['node', '-e', 'process.exit(0)']);
    expect(typeof startFrame!['ts']).toBe('string');
  });

  it('writes prepost.command.exit frame after the command exits', async () => {
    await runCommands({
      commands: [cmd('exit-cmd', ['node', '-e', 'process.exit(0)'])],
      worktreePath: tmpDir,
      logWriter,
      when: 'pre',
    });

    const frames = await readFrames();
    const exitFrame = frames.find((f) => f['type'] === 'prepost.command.exit');
    expect(exitFrame).toBeDefined();
    expect(exitFrame!['name']).toBe('exit-cmd');
    expect(exitFrame!['when']).toBe('pre');
    expect(exitFrame!['exit_code']).toBe(0);
    expect(typeof exitFrame!['elapsed_ms']).toBe('number');
  });

  it('writes prepost.command.stdout frames for each stdout line', async () => {
    await runCommands({
      commands: [
        cmd('stdout-cmd', [
          'node', '-e',
          'process.stdout.write("line1\\nline2\\nline3\\n"); process.exit(0);',
        ]),
      ],
      worktreePath: tmpDir,
      logWriter,
      when: 'post',
    });

    const frames = await readFrames();
    const stdoutFrames = frames.filter((f) => f['type'] === 'prepost.command.stdout');
    expect(stdoutFrames).toHaveLength(3);
    expect(stdoutFrames[0]!['text']).toBe('line1');
    expect(stdoutFrames[1]!['text']).toBe('line2');
    expect(stdoutFrames[2]!['text']).toBe('line3');
  });

  it('writes prepost.command.stderr frames for stderr output', async () => {
    await runCommands({
      commands: [
        cmd('stderr-cmd', [
          'node', '-e',
          'process.stderr.write("error-line\\n"); process.exit(0);',
        ]),
      ],
      worktreePath: tmpDir,
      logWriter,
      when: 'post',
    });

    const frames = await readFrames();
    const stderrFrames = frames.filter((f) => f['type'] === 'prepost.command.stderr');
    expect(stderrFrames.length).toBeGreaterThan(0);
    const allText = stderrFrames.map((f) => f['text']).join('');
    expect(allText).toContain('error-line');
  });

  it('start frame appears before exit frame in the log', async () => {
    await runCommands({
      commands: [cmd('order-cmd', ['node', '-e', 'process.exit(0)'])],
      worktreePath: tmpDir,
      logWriter,
      when: 'post',
    });

    const frames = await readFrames();
    const startIdx = frames.findIndex((f) => f['type'] === 'prepost.command.start');
    const exitIdx = frames.findIndex((f) => f['type'] === 'prepost.command.exit');
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(exitIdx).toBeGreaterThan(startIdx);
  });

  it('stdout frames appear between start and exit frames in the log', async () => {
    await runCommands({
      commands: [
        cmd('ordered', [
          'node', '-e',
          'process.stdout.write("hello\\n"); process.exit(0);',
        ]),
      ],
      worktreePath: tmpDir,
      logWriter,
      when: 'post',
    });

    const frames = await readFrames();
    const startIdx = frames.findIndex((f) => f['type'] === 'prepost.command.start');
    const stdoutIdx = frames.findIndex((f) => f['type'] === 'prepost.command.stdout');
    const exitIdx = frames.findIndex((f) => f['type'] === 'prepost.command.exit');
    expect(startIdx).toBeLessThan(stdoutIdx);
    expect(stdoutIdx).toBeLessThan(exitIdx);
  });

  it('appends frames for multiple commands to the same log', async () => {
    await runCommands({
      commands: [
        cmd('cmd-a', ['node', '-e', 'process.stdout.write("from-a\\n"); process.exit(0);']),
        cmd('cmd-b', ['node', '-e', 'process.stdout.write("from-b\\n"); process.exit(0);']),
      ],
      worktreePath: tmpDir,
      logWriter,
      when: 'post',
    });

    const frames = await readFrames();
    const stdoutFrames = frames.filter((f) => f['type'] === 'prepost.command.stdout');
    const texts = stdoutFrames.map((f) => f['text']);
    expect(texts).toContain('from-a');
    expect(texts).toContain('from-b');

    const startFrames = frames.filter((f) => f['type'] === 'prepost.command.start');
    expect(startFrames).toHaveLength(2);
    expect(startFrames[0]!['name']).toBe('cmd-a');
    expect(startFrames[1]!['name']).toBe('cmd-b');
  });

  it('exit_code in the exit frame matches the actual exit code', async () => {
    await runCommands({
      commands: [
        cmd('nonzero', ['node', '-e', 'process.exit(5)'], {
          actions: { '5': 'stop', '*': 'stop' },
        }),
      ],
      worktreePath: tmpDir,
      logWriter,
      when: 'post',
    });

    const frames = await readFrames();
    const exitFrame = frames.find((f) => f['type'] === 'prepost.command.exit');
    expect(exitFrame!['exit_code']).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 6. Environment variable injection
// ---------------------------------------------------------------------------

describe('runCommands — environment injection', () => {
  it('command inherits caller-supplied env vars', async () => {
    const outFile = path.join(tmpDir, 'env-out.txt');
    await runCommands({
      commands: [
        cmd('env-check', [
          'node', '-e',
          `require('fs').writeFileSync(${JSON.stringify(outFile)}, process.env.YOKE_TEST_VAR ?? 'missing'); process.exit(0);`,
        ]),
      ],
      worktreePath: tmpDir,
      logWriter,
      when: 'pre',
      env: { YOKE_TEST_VAR: 'injected_value' },
    });

    const content = await fs.promises.readFile(outFile, 'utf8');
    expect(content).toBe('injected_value');
  });

  it('command-specific env vars override caller env vars', async () => {
    const outFile = path.join(tmpDir, 'env-override.txt');
    await runCommands({
      commands: [
        {
          name: 'env-override',
          run: [
            'node', '-e',
            `require('fs').writeFileSync(${JSON.stringify(outFile)}, process.env.YOKE_TEST_VAR ?? 'missing'); process.exit(0);`,
          ],
          actions: { '0': 'continue' },
          env: { YOKE_TEST_VAR: 'command_value' },
        },
      ],
      worktreePath: tmpDir,
      logWriter,
      when: 'pre',
      env: { YOKE_TEST_VAR: 'caller_value' },
    });

    const content = await fs.promises.readFile(outFile, 'utf8');
    expect(content).toBe('command_value');
  });
});

// ---------------------------------------------------------------------------
// 7. Timeout (short timeout for tests)
// ---------------------------------------------------------------------------

describe('runCommands — timeout', () => {
  it('returns { kind: timeout } when the command exceeds its timeout', async () => {
    const result = await runCommands({
      commands: [
        cmd('slow', ['node', '-e', 'setTimeout(() => {}, 60_000);'], {
          actions: { '0': 'continue' },
          timeout_s: 0.2, // 200 ms — well below the 60 s child sleep
        }),
      ],
      worktreePath: tmpDir,
      logWriter,
      when: 'post',
    });
    expect(result).toMatchObject({ kind: 'timeout', command: 'slow' });
  }, 10_000);

  it('writes a timed_out exit frame to the log', async () => {
    await runCommands({
      commands: [
        cmd('slow2', ['node', '-e', 'setTimeout(() => {}, 60_000);'], {
          actions: { '0': 'continue' },
          timeout_s: 0.2,
        }),
      ],
      worktreePath: tmpDir,
      logWriter,
      when: 'pre',
    });

    const frames = await readFrames();
    const exitFrame = frames.find((f) => f['type'] === 'prepost.command.exit');
    expect(exitFrame).toBeDefined();
    expect(exitFrame!['exit_code']).toBeNull();
    expect(exitFrame!['timed_out']).toBe(true);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// 8. when field propagation
// ---------------------------------------------------------------------------

describe('runCommands — when field', () => {
  it('frames carry when=pre when opts.when is pre', async () => {
    await runCommands({
      commands: [cmd('check', ['node', '-e', 'process.exit(0)'])],
      worktreePath: tmpDir,
      logWriter,
      when: 'pre',
    });
    const frames = await readFrames();
    for (const f of frames) {
      expect(f['when']).toBe('pre');
    }
  });

  it('frames carry when=post when opts.when is post', async () => {
    await runCommands({
      commands: [cmd('check', ['node', '-e', 'process.exit(0)'])],
      worktreePath: tmpDir,
      logWriter,
      when: 'post',
    });
    const frames = await readFrames();
    for (const f of frames) {
      expect(f['when']).toBe('post');
    }
  });
});

// ---------------------------------------------------------------------------
// 9. runs array — per-command execution records (AC-6)
// ---------------------------------------------------------------------------

describe('runCommands — runs array (AC-6)', () => {
  it('complete result carries one record per command', async () => {
    const result = await runCommands({
      commands: [
        cmd('a', ['node', '-e', 'process.exit(0)']),
        cmd('b', ['node', '-e', 'process.exit(0)']),
      ],
      worktreePath: tmpDir,
      logWriter,
      when: 'pre',
    });
    expect(result.kind).toBe('complete');
    expect(result.runs).toHaveLength(2);
    expect(result.runs[0].commandName).toBe('a');
    expect(result.runs[1].commandName).toBe('b');
  });

  it('run record carries correct argv, when, exitCode, actionTaken for continue', async () => {
    const result = await runCommands({
      commands: [cmd('check', ['node', '-e', 'process.exit(0)'])],
      worktreePath: tmpDir,
      logWriter,
      when: 'post',
    });
    expect(result.kind).toBe('complete');
    const rec = result.runs[0];
    expect(rec.commandName).toBe('check');
    expect(rec.argv).toEqual(['node', '-e', 'process.exit(0)']);
    expect(rec.when).toBe('post');
    expect(rec.exitCode).toBe(0);
    expect(rec.actionTaken).toBe('continue');
    expect(typeof rec.startedAt).toBe('string');
    expect(typeof rec.endedAt).toBe('string');
  });

  it('action result carries records for all commands that ran', async () => {
    const result = await runCommands({
      commands: [
        cmd('first', ['node', '-e', 'process.exit(0)']),
        cmd('second', ['node', '-e', 'process.exit(1)'], {
          actions: { '1': 'stop-and-ask', '*': 'stop' },
        }),
        cmd('third', ['node', '-e', 'process.exit(0)']),  // must NOT run
      ],
      worktreePath: tmpDir,
      logWriter,
      when: 'post',
    });
    expect(result.kind).toBe('action');
    // Only two records: first (continue) and second (stop-and-ask). Third never ran.
    expect(result.runs).toHaveLength(2);
    expect(result.runs[0].commandName).toBe('first');
    expect(result.runs[0].actionTaken).toBe('continue');
    expect(result.runs[1].commandName).toBe('second');
    expect(result.runs[1].actionTaken).toBe('stop-and-ask');
    expect(result.runs[1].exitCode).toBe(1);
  });

  it('timeout record has exitCode=null and actionTaken=null', async () => {
    const result = await runCommands({
      commands: [
        cmd('slow', ['node', '-e', 'setTimeout(() => {}, 60_000);'], {
          actions: { '0': 'continue', '*': 'stop' },
          timeout_s: 0.2,
        }),
      ],
      worktreePath: tmpDir,
      logWriter,
      when: 'pre',
    });
    expect(result.kind).toBe('timeout');
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].exitCode).toBeNull();
    expect(result.runs[0].actionTaken).toBeNull();
  }, 10_000);

  it('spawn_failed record has exitCode=null and actionTaken=null', async () => {
    const result = await runCommands({
      commands: [
        cmd('missing', ['this-binary-does-not-exist-xyz-yoke-test'], {
          actions: { '0': 'continue', '*': 'stop' },
        }),
      ],
      worktreePath: tmpDir,
      logWriter,
      when: 'pre',
    });
    expect(result.kind).toBe('spawn_failed');
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].exitCode).toBeNull();
    expect(result.runs[0].actionTaken).toBeNull();
  });

  it('unhandled_exit record has the exit code and actionTaken=null', async () => {
    const result = await runCommands({
      commands: [
        cmd('check', ['node', '-e', 'process.exit(42)'], {
          actions: { '0': 'continue', '*': 'continue' },
        }),
      ],
      worktreePath: tmpDir,
      logWriter,
      when: 'post',
    });
    // Exit code 42 with no exact match and wildcard is 'continue' → unhandled? No:
    // '*' maps to 'continue', so it returns kind='continue_next', then complete.
    // Let's use a map with no '*' key to force unhandled.
    // Actually the 'cmd' helper adds '*', so override it here.
    const result2 = await runCommands({
      commands: [
        {
          name: 'check2',
          run: ['node', '-e', 'process.exit(42)'],
          actions: { '0': 'continue' },  // no '*'
        },
      ],
      worktreePath: tmpDir,
      logWriter,
      when: 'post',
    });
    expect(result2.kind).toBe('unhandled_exit');
    expect(result2.runs).toHaveLength(1);
    expect(result2.runs[0].exitCode).toBe(42);
    expect(result2.runs[0].actionTaken).toBeNull();
  });
});
