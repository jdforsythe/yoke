/**
 * Pre/Post Command Runner — stdout/stderr → file capture (F3).
 *
 * Verifies that when `outputDir` is provided, each command's stdout and
 * stderr are streamed to separate files under that directory, the contents
 * match what the command actually wrote, and the file paths round-trip via
 * PrePostRunRecord.stdoutPath / stderrPath.  Caps each file at
 * OUTPUT_CAPTURE_LIMIT bytes (see _openCappedWriteStream doc block).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrePostCommand } from '../../src/shared/types/config.js';
import { OUTPUT_CAPTURE_LIMIT, runCommands } from '../../src/server/prepost/runner.js';
import { SessionLogWriter } from '../../src/server/session-log/writer.js';

let tmpDir: string;
let outputDir: string;
let logPath: string;
let logWriter: SessionLogWriter;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yoke-prepost-out-'));
  outputDir = path.join(tmpDir, 'prepost-out');
  logPath = path.join(tmpDir, 'session.jsonl');
  logWriter = new SessionLogWriter(logPath);
  await logWriter.open();
});

afterEach(async () => {
  await logWriter.close();
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

// Minimal PrePostCommand builder (mirrors runner.test.ts).
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
// 1. Happy path — both streams capture to their respective files
// ---------------------------------------------------------------------------

describe('runCommands — output file capture', () => {
  it('writes stdout and stderr to separate files matching PrePostRunRecord paths', async () => {
    const result = await runCommands({
      commands: [cmd('capture', [
        'node', '-e',
        'process.stdout.write("hello-stdout\\n"); process.stderr.write("hello-stderr\\n"); process.exit(0);',
      ])],
      worktreePath: tmpDir,
      logWriter,
      when: 'post',
      outputDir,
    });

    expect(result.kind).toBe('complete');
    const rec = result.runs[0];
    expect(rec.stdoutPath).not.toBeNull();
    expect(rec.stderrPath).not.toBeNull();

    // Paths live inside the configured outputDir.
    expect(rec.stdoutPath!.startsWith(outputDir)).toBe(true);
    expect(rec.stderrPath!.startsWith(outputDir)).toBe(true);

    // Files actually exist on disk with the expected contents.
    const stdoutContent = await fs.promises.readFile(rec.stdoutPath!, 'utf8');
    const stderrContent = await fs.promises.readFile(rec.stderrPath!, 'utf8');
    expect(stdoutContent).toBe('hello-stdout\n');
    expect(stderrContent).toBe('hello-stderr\n');
  });

  it('returns non-null paths for commands that produce no output (empty files on disk)', async () => {
    const result = await runCommands({
      commands: [cmd('quiet', ['node', '-e', 'process.exit(0)'])],
      worktreePath: tmpDir,
      logWriter,
      when: 'pre',
      outputDir,
    });

    expect(result.kind).toBe('complete');
    const rec = result.runs[0];
    expect(rec.stdoutPath).not.toBeNull();
    expect(rec.stderrPath).not.toBeNull();

    const stdoutContent = await fs.promises.readFile(rec.stdoutPath!, 'utf8');
    const stderrContent = await fs.promises.readFile(rec.stderrPath!, 'utf8');
    expect(stdoutContent).toBe('');
    expect(stderrContent).toBe('');
  });

  it('returns null stdoutPath/stderrPath when outputDir is not provided', async () => {
    const result = await runCommands({
      commands: [cmd('no-dir', [
        'node', '-e',
        'process.stdout.write("ignored\\n"); process.exit(0);',
      ])],
      worktreePath: tmpDir,
      logWriter,
      when: 'post',
      // no outputDir
    });

    expect(result.kind).toBe('complete');
    const rec = result.runs[0];
    expect(rec.stdoutPath).toBeNull();
    expect(rec.stderrPath).toBeNull();
  });

  it('filenames include when, sanitized command name, and stay inside outputDir', async () => {
    const result = await runCommands({
      commands: [cmd('my cmd/../evil', ['node', '-e', 'process.exit(0)'])],
      worktreePath: tmpDir,
      logWriter,
      when: 'post',
      outputDir,
    });

    const rec = result.runs[0];
    expect(rec.stdoutPath).not.toBeNull();
    // Sanitized name: path separators and spaces collapse to '_'.
    expect(path.basename(rec.stdoutPath!)).toMatch(/-post-my_cmd_+evil\.stdout\.log$/);
    // Path stays inside outputDir — no traversal via '..'.
    const resolved = path.resolve(rec.stdoutPath!);
    expect(resolved.startsWith(path.resolve(outputDir))).toBe(true);
  });

  it('preserves the legacy in-memory output buffer (fresh_with_failure_summary contract)', async () => {
    const result = await runCommands({
      commands: [cmd('legacy', [
        'node', '-e',
        'process.stdout.write("bytes-for-handoff\\n"); process.exit(0);',
      ])],
      worktreePath: tmpDir,
      logWriter,
      when: 'post',
      outputDir,
    });

    expect(result.kind).toBe('complete');
    // The in-memory `output` field — unchanged by F3 — carries the same bytes.
    expect(result.runs[0].output).toContain('bytes-for-handoff');
  });
});

// ---------------------------------------------------------------------------
// 2. Truncation — output cap is enforced at the file level
// ---------------------------------------------------------------------------

describe('runCommands — output file truncation at OUTPUT_CAPTURE_LIMIT', () => {
  it('caps stdout file at OUTPUT_CAPTURE_LIMIT bytes and the run still completes cleanly', async () => {
    // 4× the cap worth of bytes written to stdout.
    const targetBytes = OUTPUT_CAPTURE_LIMIT * 4;
    const script = `
      const chunk = 'x'.repeat(4096);
      let written = 0;
      const target = ${targetBytes};
      (function loop() {
        while (written < target) {
          if (!process.stdout.write(chunk)) {
            return process.stdout.once('drain', loop);
          }
          written += chunk.length;
        }
        process.exit(0);
      })();
    `;
    const result = await runCommands({
      commands: [cmd('big', ['node', '-e', script])],
      worktreePath: tmpDir,
      logWriter,
      when: 'post',
      outputDir,
    });

    expect(result.kind).toBe('complete');
    const rec = result.runs[0];
    const stats = await fs.promises.stat(rec.stdoutPath!);
    // Exactly capped — not larger than OUTPUT_CAPTURE_LIMIT.
    expect(stats.size).toBe(OUTPUT_CAPTURE_LIMIT);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// 3. Spawn failure — no orphan files, null paths on the record
// ---------------------------------------------------------------------------

describe('runCommands — spawn failure output-file handling', () => {
  it('leaves no orphan files and returns null paths when the binary does not exist', async () => {
    const result = await runCommands({
      commands: [cmd('missing', ['this-binary-does-not-exist-xyz-yoke-f3'], {
        actions: { '0': 'continue', '*': 'stop' },
      })],
      worktreePath: tmpDir,
      logWriter,
      when: 'post',
      outputDir,
    });

    expect(result.kind).toBe('spawn_failed');
    const rec = result.runs[0];
    expect(rec.stdoutPath).toBeNull();
    expect(rec.stderrPath).toBeNull();

    // outputDir may have been created by mkdir -p, but must contain no files
    // for this command (no orphan zero-byte captures left behind).
    const exists = await fs.promises.access(outputDir).then(() => true).catch(() => false);
    if (exists) {
      const entries = await fs.promises.readdir(outputDir);
      expect(entries).toHaveLength(0);
    }
  });

  it('returns null paths when run array is empty (no directory operations at all)', async () => {
    const result = await runCommands({
      commands: [{ name: 'empty', run: [], actions: { '0': 'continue' } }],
      worktreePath: tmpDir,
      logWriter,
      when: 'pre',
      outputDir,
    });

    expect(result.kind).toBe('spawn_failed');
    expect(result.runs[0].stdoutPath).toBeNull();
    expect(result.runs[0].stderrPath).toBeNull();
  });
});
