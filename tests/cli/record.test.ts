import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runRecord, readRecordMarker, clearRecordMarker } from '../../src/cli/record.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-record-test-'));
}
function removeTmpDir(d: string): void {
  fs.rmSync(d, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('yoke record — runRecord()', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { removeTmpDir(tmpDir); });

  it('creates .yoke/record.json with enabled=true and capturePath', () => {
    const result = runRecord({ cwd: tmpDir });
    const markerPath = path.join(tmpDir, '.yoke', 'record.json');
    expect(fs.existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as {
      enabled: boolean;
      capturePath: string;
      createdAt: string;
    };
    expect(marker.enabled).toBe(true);
    expect(typeof marker.capturePath).toBe('string');
    expect(marker.capturePath.length).toBeGreaterThan(0);
    expect(marker.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.markerPath).toBe(markerPath);
  });

  it('uses provided capturePath (absolute)', () => {
    const custom = path.join(tmpDir, 'my-fixture.jsonl');
    const result = runRecord({ cwd: tmpDir, capturePath: custom });
    expect(result.capturePath).toBe(path.resolve(custom));
    const marker = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.yoke', 'record.json'), 'utf8'),
    ) as { capturePath: string };
    expect(marker.capturePath).toBe(path.resolve(custom));
  });

  it('default capturePath is inside .yoke/fixtures/', () => {
    const result = runRecord({ cwd: tmpDir });
    expect(result.capturePath).toContain(path.join(tmpDir, '.yoke', 'fixtures'));
    expect(result.capturePath).toMatch(/\.jsonl$/);
  });

  it('creates parent directory of capturePath if absent', () => {
    const custom = path.join(tmpDir, 'deep', 'dir', 'fixture.jsonl');
    runRecord({ cwd: tmpDir, capturePath: custom });
    expect(fs.existsSync(path.join(tmpDir, 'deep', 'dir'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readRecordMarker()
// ---------------------------------------------------------------------------

describe('readRecordMarker()', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { removeTmpDir(tmpDir); });

  it('returns null when no marker exists', () => {
    expect(readRecordMarker(tmpDir)).toBeNull();
  });

  it('returns the marker after runRecord()', () => {
    runRecord({ cwd: tmpDir });
    const marker = readRecordMarker(tmpDir);
    expect(marker).not.toBeNull();
    expect(marker!.enabled).toBe(true);
    expect(typeof marker!.capturePath).toBe('string');
  });

  it('returns null for a malformed marker file', () => {
    const yokeDir = path.join(tmpDir, '.yoke');
    fs.mkdirSync(yokeDir, { recursive: true });
    fs.writeFileSync(path.join(yokeDir, 'record.json'), 'not-json', 'utf8');
    expect(readRecordMarker(tmpDir)).toBeNull();
  });

  it('returns null when marker has enabled=false', () => {
    const yokeDir = path.join(tmpDir, '.yoke');
    fs.mkdirSync(yokeDir, { recursive: true });
    fs.writeFileSync(
      path.join(yokeDir, 'record.json'),
      JSON.stringify({ enabled: false, capturePath: '/some/path', createdAt: '' }),
      'utf8',
    );
    expect(readRecordMarker(tmpDir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// clearRecordMarker()
// ---------------------------------------------------------------------------

describe('clearRecordMarker()', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { removeTmpDir(tmpDir); });

  it('removes an existing marker', () => {
    runRecord({ cwd: tmpDir });
    const markerPath = path.join(tmpDir, '.yoke', 'record.json');
    expect(fs.existsSync(markerPath)).toBe(true);
    clearRecordMarker(tmpDir);
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it('does not throw when marker is already absent', () => {
    expect(() => clearRecordMarker(tmpDir)).not.toThrow();
  });

  it('readRecordMarker returns null after clear', () => {
    runRecord({ cwd: tmpDir });
    clearRecordMarker(tmpDir);
    expect(readRecordMarker(tmpDir)).toBeNull();
  });
});
