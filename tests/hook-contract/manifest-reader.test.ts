/**
 * Unit tests for src/server/hook-contract/manifest-reader.ts
 *
 * Coverage:
 *   AC-4  Absence of .yoke/last-check.json treated as normal → 'absent'.
 *   AC-5  Malformed manifest → 'malformed' (does NOT block phase acceptance).
 *   AC-6  hook_version !== "1" → 'unknown_version' with rawJson passthrough.
 *         Valid hook_version "1" → 'ok' with structured manifest.
 *   RC-3  readLastCheckManifest never throws.
 *
 * Tests use a real tmp-dir with the .yoke/ subdirectory so paths match
 * what the production code reads (MANIFEST_RELATIVE_PATH = '.yoke/last-check.json').
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLastCheckManifest } from '../../src/server/hook-contract/manifest-reader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
const MANIFEST_DIR = '.yoke';
const MANIFEST_FILE = path.join(MANIFEST_DIR, 'last-check.json');

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-manifest-test-'));
  fs.mkdirSync(path.join(tmpDir, MANIFEST_DIR), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeManifest(content: string): void {
  fs.writeFileSync(path.join(tmpDir, MANIFEST_FILE), content, 'utf8');
}

function writeManifestJson(obj: unknown): void {
  writeManifest(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// AC-4: absent
// ---------------------------------------------------------------------------

describe('AC-4: absent manifest', () => {
  it('returns absent when .yoke/last-check.json does not exist', () => {
    expect(readLastCheckManifest(tmpDir)).toEqual({ kind: 'absent' });
  });

  it('returns absent when .yoke/ directory itself does not exist', () => {
    fs.rmdirSync(path.join(tmpDir, MANIFEST_DIR));
    expect(readLastCheckManifest(tmpDir)).toEqual({ kind: 'absent' });
  });
});

// ---------------------------------------------------------------------------
// AC-5: malformed manifest
// ---------------------------------------------------------------------------

describe('AC-5: malformed manifest', () => {
  it('returns malformed for invalid JSON', () => {
    writeManifest('not-json{{{');
    const result = readLastCheckManifest(tmpDir);
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.detail).toMatch(/JSON parse error/);
    }
  });

  it('returns malformed for a JSON array at the root', () => {
    writeManifest('[]');
    const result = readLastCheckManifest(tmpDir);
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.detail).toMatch(/must be a JSON object/);
    }
  });

  it('returns malformed for a JSON null at the root', () => {
    writeManifest('null');
    const result = readLastCheckManifest(tmpDir);
    expect(result.kind).toBe('malformed');
  });

  it('returns malformed for a JSON string at the root', () => {
    writeManifest('"hello"');
    const result = readLastCheckManifest(tmpDir);
    expect(result.kind).toBe('malformed');
  });

  it('returns malformed when hook_version field is missing', () => {
    writeManifestJson({ ran_at: '2026-01-01T00:00:00Z', gates: [] });
    const result = readLastCheckManifest(tmpDir);
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.detail).toMatch(/hook_version/);
    }
  });

  it('returns malformed when ran_at is missing (v1 shape)', () => {
    writeManifestJson({ hook_version: '1', gates: [] });
    const result = readLastCheckManifest(tmpDir);
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.detail).toMatch(/ran_at/);
    }
  });

  it('returns malformed when ran_at is not a string (v1 shape)', () => {
    writeManifestJson({ hook_version: '1', ran_at: 12345, gates: [] });
    const result = readLastCheckManifest(tmpDir);
    expect(result.kind).toBe('malformed');
  });

  it('returns malformed when gates is missing (v1 shape)', () => {
    writeManifestJson({ hook_version: '1', ran_at: '2026-01-01T00:00:00Z' });
    const result = readLastCheckManifest(tmpDir);
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.detail).toMatch(/gates/);
    }
  });

  it('returns malformed when gates is not an array (v1 shape)', () => {
    writeManifestJson({ hook_version: '1', ran_at: '2026-01-01T00:00:00Z', gates: 'bad' });
    const result = readLastCheckManifest(tmpDir);
    expect(result.kind).toBe('malformed');
  });

  it('returns malformed when a gate is not an object', () => {
    writeManifestJson({
      hook_version: '1',
      ran_at: '2026-01-01T00:00:00Z',
      gates: ['not-an-object'],
    });
    const result = readLastCheckManifest(tmpDir);
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.detail).toMatch(/gates\[0\]/);
    }
  });

  it('returns malformed when gate.name is not a string', () => {
    writeManifestJson({
      hook_version: '1',
      ran_at: '2026-01-01T00:00:00Z',
      gates: [{ name: 42, ok: true, duration_ms: 100 }],
    });
    const result = readLastCheckManifest(tmpDir);
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.detail).toMatch(/name must be a string/);
    }
  });

  it('returns malformed when gate.ok is not a boolean', () => {
    writeManifestJson({
      hook_version: '1',
      ran_at: '2026-01-01T00:00:00Z',
      gates: [{ name: 'lint', ok: 'yes', duration_ms: 100 }],
    });
    const result = readLastCheckManifest(tmpDir);
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.detail).toMatch(/ok must be a boolean/);
    }
  });

  it('returns malformed when gate.duration_ms is not a number', () => {
    writeManifestJson({
      hook_version: '1',
      ran_at: '2026-01-01T00:00:00Z',
      gates: [{ name: 'test', ok: true, duration_ms: '100ms' }],
    });
    const result = readLastCheckManifest(tmpDir);
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.detail).toMatch(/duration_ms must be a number/);
    }
  });

  it('never throws for any input (RC-3)', () => {
    // Write a binary-ish file that definitely won't parse as JSON.
    fs.writeFileSync(path.join(tmpDir, MANIFEST_FILE), Buffer.from([0x00, 0xff, 0xfe]));
    expect(() => readLastCheckManifest(tmpDir)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC-6: unknown_version
// ---------------------------------------------------------------------------

describe('AC-6: unknown hook_version', () => {
  it('returns unknown_version for hook_version "2"', () => {
    const raw = JSON.stringify({ hook_version: '2', ran_at: '2026-01-01T00:00:00Z', gates: [] });
    writeManifest(raw);
    const result = readLastCheckManifest(tmpDir);
    expect(result.kind).toBe('unknown_version');
    if (result.kind === 'unknown_version') {
      expect(result.hookVersion).toBe('2');
      expect(result.rawJson).toBe(raw);
    }
  });

  it('returns unknown_version for hook_version 1 (number, not string)', () => {
    const raw = JSON.stringify({ hook_version: 1, ran_at: '2026-01-01T00:00:00Z', gates: [] });
    writeManifest(raw);
    const result = readLastCheckManifest(tmpDir);
    expect(result.kind).toBe('unknown_version');
    if (result.kind === 'unknown_version') {
      expect(result.hookVersion).toBe(1);
      expect(result.rawJson).toBe(raw);
    }
  });

  it('rawJson is the exact bytes written to disk', () => {
    const raw = '{"hook_version":"99","extra":true}';
    writeManifest(raw);
    const result = readLastCheckManifest(tmpDir);
    if (result.kind === 'unknown_version') {
      expect(result.rawJson).toBe(raw);
    }
  });
});

// ---------------------------------------------------------------------------
// Valid hook_version "1"
// ---------------------------------------------------------------------------

describe('valid hook_version "1" manifest', () => {
  const VALID_MANIFEST = {
    hook_version: '1',
    ran_at: '2026-04-11T12:34:56Z',
    gates: [
      { name: 'typecheck', ok: true, duration_ms: 1203 },
      { name: 'lint',      ok: true, duration_ms: 890 },
      { name: 'test',      ok: false, duration_ms: 5420, test_count: 42, pass_count: 40 },
    ],
  };

  it('returns ok with structured manifest', () => {
    writeManifestJson(VALID_MANIFEST);
    const result = readLastCheckManifest(tmpDir);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.manifest.hook_version).toBe('1');
      expect(result.manifest.ran_at).toBe('2026-04-11T12:34:56Z');
      expect(result.manifest.gates).toHaveLength(3);
    }
  });

  it('gate fields are populated correctly', () => {
    writeManifestJson(VALID_MANIFEST);
    const result = readLastCheckManifest(tmpDir);
    if (result.kind === 'ok') {
      const gate = result.manifest.gates[2];
      expect(gate.name).toBe('test');
      expect(gate.ok).toBe(false);
      expect(gate.duration_ms).toBe(5420);
    }
  });

  it('passes extra fields through verbatim (AC-6 extras)', () => {
    writeManifestJson(VALID_MANIFEST);
    const result = readLastCheckManifest(tmpDir);
    if (result.kind === 'ok') {
      const testGate = result.manifest.gates[2];
      expect((testGate as Record<string, unknown>)['test_count']).toBe(42);
      expect((testGate as Record<string, unknown>)['pass_count']).toBe(40);
    }
  });

  it('accepts empty gates array', () => {
    writeManifestJson({ hook_version: '1', ran_at: '2026-01-01T00:00:00Z', gates: [] });
    const result = readLastCheckManifest(tmpDir);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.manifest.gates).toHaveLength(0);
    }
  });
});
