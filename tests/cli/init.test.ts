import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runInit } from '../../src/cli/init.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-init-test-'));
}

function removeTmpDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('yoke init', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  // AC-1: creates the template file in a fresh directory.
  it('creates .yoke/templates/default.yml on first run', () => {
    const result = runInit(tmpDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.created).toHaveLength(1);

    const defaultYml = path.join(tmpDir, '.yoke', 'templates', 'default.yml');
    expect(fs.existsSync(defaultYml)).toBe(true);
    const content = fs.readFileSync(defaultYml, 'utf8');
    expect(content).toContain('version: "1"');
    expect(content).toContain('template:');
    expect(content).toContain('name:');
  });

  // AC-1: no longer creates .yoke.yml at the repo root.
  it('does NOT create a root .yoke.yml', () => {
    const result = runInit(tmpDir);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.yoke.yml'))).toBe(false);
  });

  // AC-1: scaffolded template uses the `template:` key, not `project:`.
  it('default.yml uses template: key (not project:)', () => {
    runInit(tmpDir);
    const content = fs.readFileSync(
      path.join(tmpDir, '.yoke', 'templates', 'default.yml'),
      'utf8',
    );
    expect(content).toContain('template:');
    expect(content).not.toContain('project:');
  });

  // AC-2: exits with an error when default.yml already exists.
  it('returns already_exists error when default.yml exists', () => {
    const defaultYml = path.join(tmpDir, '.yoke', 'templates', 'default.yml');
    fs.mkdirSync(path.dirname(defaultYml), { recursive: true });
    fs.writeFileSync(defaultYml, 'existing content', 'utf8');

    const result = runInit(tmpDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('already_exists');
    expect(result.error.details?.[0]).toBe(defaultYml);
    expect(result.error.message).toContain('already exists');
    expect(result.error.message).toContain('never overwrites');
  });

  // RC: never overwrites — content unchanged when existing file found.
  it('does not overwrite existing default.yml', () => {
    const defaultYml = path.join(tmpDir, '.yoke', 'templates', 'default.yml');
    fs.mkdirSync(path.dirname(defaultYml), { recursive: true });
    fs.writeFileSync(defaultYml, 'original', 'utf8');

    runInit(tmpDir);

    expect(fs.readFileSync(defaultYml, 'utf8')).toBe('original');
  });

  // Scaffolded default.yml contains a valid version field.
  it('default.yml template has version "1"', () => {
    runInit(tmpDir);
    const content = fs.readFileSync(
      path.join(tmpDir, '.yoke', 'templates', 'default.yml'),
      'utf8',
    );
    expect(content).toMatch(/^version:\s+"1"/m);
  });

  // Scaffolded template has pipeline and phases sections.
  it('default.yml has pipeline and phases sections', () => {
    runInit(tmpDir);
    const content = fs.readFileSync(
      path.join(tmpDir, '.yoke', 'templates', 'default.yml'),
      'utf8',
    );
    expect(content).toContain('pipeline:');
    expect(content).toContain('phases:');
    expect(content).toContain('prompt_template:');
  });

  // Idempotence: running a second time after success always fails.
  it('fails on a second run after successful init', () => {
    const r1 = runInit(tmpDir);
    expect(r1.ok).toBe(true);

    const r2 = runInit(tmpDir);
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.code).toBe('already_exists');
  });
});
