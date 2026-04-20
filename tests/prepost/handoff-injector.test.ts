/**
 * Unit tests for injectHookFailure (src/server/prepost/handoff-injector.ts).
 *
 * Coverage:
 *   - Creates handoff.json when file is absent
 *   - Appends to existing entries array
 *   - Handles malformed JSON (non-object content) gracefully
 *   - Truncates output at MAX_ENTRY_OUTPUT_BYTES
 *   - Entry has correct phase, attempt, command, exit_code, blocking_issues, harness_injected fields
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { injectHookFailure } from '../../src/server/prepost/handoff-injector.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-handoff-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readHandoff(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, 'handoff.json'), 'utf8'));
}

describe('injectHookFailure', () => {
  it('creates handoff.json when file is absent', () => {
    injectHookFailure(tmpDir, {
      phase: 'implement',
      attempt: 1,
      sessionId: "sess-test",
      command: 'run-tests',
      exitCode: 1,
      output: 'FAIL src/foo.test.ts',
    });

    const data = readHandoff();
    expect(data.entries).toBeDefined();
    expect(Array.isArray(data.entries)).toBe(true);
    expect((data.entries as unknown[]).length).toBe(1);
  });

  it('appends to existing entries array', () => {
    // Write initial handoff.json with one entry.
    const initial = {
      feature: 'test-feature',
      entries: [{ phase: 'plan', attempt: 1, ts: '2026-01-01T00:00:00Z', note: 'planned' }],
    };
    fs.writeFileSync(path.join(tmpDir, 'handoff.json'), JSON.stringify(initial), 'utf8');

    injectHookFailure(tmpDir, {
      phase: 'implement',
      attempt: 2,
      sessionId: "sess-test",
      command: 'run-typecheck',
      exitCode: 2,
      output: 'Type error in foo.ts',
    });

    const data = readHandoff();
    const entries = data.entries as unknown[];
    expect(entries.length).toBe(2);
    // Original entry preserved.
    expect((entries[0] as Record<string, unknown>).phase).toBe('plan');
    // New entry appended.
    expect((entries[1] as Record<string, unknown>).phase).toBe('implement:hook-failure');
  });

  it('handles malformed JSON gracefully (non-object content)', () => {
    // Write something that parses as a non-object (array).
    fs.writeFileSync(path.join(tmpDir, 'handoff.json'), '[1,2,3]', 'utf8');

    injectHookFailure(tmpDir, {
      phase: 'review',
      attempt: 1,
      sessionId: "sess-test",
      command: 'lint',
      exitCode: 1,
      output: 'lint failed',
    });

    const data = readHandoff();
    expect(Array.isArray(data.entries)).toBe(true);
    expect((data.entries as unknown[]).length).toBe(1);
  });

  it('handles completely invalid JSON gracefully', () => {
    fs.writeFileSync(path.join(tmpDir, 'handoff.json'), '{{{not json', 'utf8');

    injectHookFailure(tmpDir, {
      phase: 'implement',
      attempt: 1,
      sessionId: "sess-test",
      command: 'test',
      exitCode: 1,
      output: 'test failure',
    });

    const data = readHandoff();
    expect(Array.isArray(data.entries)).toBe(true);
    expect((data.entries as unknown[]).length).toBe(1);
  });

  it('truncates output at MAX_ENTRY_OUTPUT_BYTES (16 KB)', () => {
    const longOutput = 'x'.repeat(32_000);

    injectHookFailure(tmpDir, {
      phase: 'implement',
      attempt: 1,
      sessionId: "sess-test",
      command: 'big-test',
      exitCode: 1,
      output: longOutput,
    });

    const data = readHandoff();
    const entries = data.entries as Array<Record<string, unknown>>;
    const issues = entries[0].blocking_issues as string[];
    // The blocking_issues string should contain a truncation note.
    expect(issues[0]).toContain('truncated');
    // The entry output should be shorter than the original.
    expect(issues[0].length).toBeLessThan(longOutput.length);
  });

  it('entry has correct shape with all expected fields', () => {
    injectHookFailure(tmpDir, {
      phase: 'implement',
      attempt: 3,
      sessionId: "sess-test",
      command: 'run-typecheck',
      exitCode: 2,
      output: 'error TS2345: ...',
    });

    const data = readHandoff();
    const entry = (data.entries as Array<Record<string, unknown>>)[0];

    expect(entry.phase).toBe('implement:hook-failure');
    expect(entry.attempt).toBe(3);
    expect(entry.harness_injected).toBe(true);
    expect(entry.command).toBe('run-typecheck');
    expect(entry.exit_code).toBe(2);
    expect(entry.ts).toBeDefined();
    expect(typeof entry.ts).toBe('string');
    expect(Array.isArray(entry.blocking_issues)).toBe(true);
    const issues = entry.blocking_issues as string[];
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain('run-typecheck failed (exit 2)');
    expect(issues[0]).toContain('error TS2345');
  });

  it('handles null exitCode for timeout/spawn errors', () => {
    injectHookFailure(tmpDir, {
      phase: 'implement',
      attempt: 1,
      sessionId: "sess-test",
      command: 'slow-test',
      exitCode: null,
      output: 'timed out',
    });

    const data = readHandoff();
    const entry = (data.entries as Array<Record<string, unknown>>)[0];
    expect(entry.exit_code).toBeNull();
    const issues = entry.blocking_issues as string[];
    expect(issues[0]).toContain('exit null');
  });

  it('preserves existing non-entries fields in handoff.json', () => {
    const initial = {
      feature: 'my-feature',
      session_id: '12345',
      entries: [],
    };
    fs.writeFileSync(path.join(tmpDir, 'handoff.json'), JSON.stringify(initial), 'utf8');

    injectHookFailure(tmpDir, {
      phase: 'implement',
      attempt: 1,
      sessionId: "sess-test",
      command: 'test',
      exitCode: 1,
      output: 'fail',
    });

    const data = readHandoff();
    expect(data.feature).toBe('my-feature');
    expect(data.session_id).toBe('12345');
    expect((data.entries as unknown[]).length).toBe(1);
  });
});
