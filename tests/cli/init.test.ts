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

  // AC-1: creates all four files in a fresh directory.
  it('creates .yoke.yml and three prompt templates on first run', () => {
    const result = runInit(tmpDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.created).toHaveLength(4);

    const yokeYml = path.join(tmpDir, '.yoke.yml');
    expect(fs.existsSync(yokeYml)).toBe(true);
    expect(fs.readFileSync(yokeYml, 'utf8')).toContain('version: "1"');

    const implementMd = path.join(tmpDir, '.yoke', 'prompts', 'implement.md');
    expect(fs.existsSync(implementMd)).toBe(true);

    const planMd = path.join(tmpDir, '.yoke', 'prompts', 'plan.md');
    expect(fs.existsSync(planMd)).toBe(true);

    const reviewMd = path.join(tmpDir, '.yoke', 'prompts', 'review.md');
    expect(fs.existsSync(reviewMd)).toBe(true);
  });

  // AC-2a: exits with an error when .yoke.yml already exists.
  it('returns already_exists error when .yoke.yml exists', () => {
    const yokeYml = path.join(tmpDir, '.yoke.yml');
    fs.writeFileSync(yokeYml, 'existing content', 'utf8');

    const result = runInit(tmpDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('already_exists');
    expect(result.error.path).toBe(yokeYml);
    expect(result.error.message).toContain('already exists');
    expect(result.error.message).toContain('never overwrites');
  });

  // AC-2b: refuses if any prompt template already exists.
  it('returns already_exists error when a prompt template exists', () => {
    const promptsDir = path.join(tmpDir, '.yoke', 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    const implementMd = path.join(promptsDir, 'implement.md');
    fs.writeFileSync(implementMd, '# existing', 'utf8');

    const result = runInit(tmpDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('already_exists');
    expect(result.error.path).toBe(implementMd);
  });

  // RC: never overwrites — no partial creation when first file exists.
  it('does not create any files when the first target already exists', () => {
    const yokeYml = path.join(tmpDir, '.yoke.yml');
    fs.writeFileSync(yokeYml, 'original', 'utf8');

    runInit(tmpDir);

    // .yoke.yml still has original content — not overwritten.
    expect(fs.readFileSync(yokeYml, 'utf8')).toBe('original');
    // No prompt templates were created.
    const promptsDir = path.join(tmpDir, '.yoke', 'prompts');
    expect(fs.existsSync(promptsDir)).toBe(false);
  });

  // RC: no partial creation when a later file exists.
  it('does not create any files when a later target already exists', () => {
    const promptsDir = path.join(tmpDir, '.yoke', 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'review.md'), '# existing review', 'utf8');

    const result = runInit(tmpDir);
    expect(result.ok).toBe(false);

    // .yoke.yml was NOT created (pre-flight checks all targets before any write).
    expect(fs.existsSync(path.join(tmpDir, '.yoke.yml'))).toBe(false);
  });

  // Scaffolded .yoke.yml contains a valid version field.
  it('.yoke.yml template has version "1"', () => {
    const result = runInit(tmpDir);
    expect(result.ok).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, '.yoke.yml'), 'utf8');
    expect(content).toMatch(/^version:\s+"1"/m);
  });

  // Prompt templates contain {{item}} and {{architecture}} template vars.
  it('implement template contains expected template variables', () => {
    const result = runInit(tmpDir);
    expect(result.ok).toBe(true);
    const content = fs.readFileSync(
      path.join(tmpDir, '.yoke', 'prompts', 'implement.md'),
      'utf8',
    );
    expect(content).toContain('{{item}}');
    expect(content).toContain('{{architecture}}');
    expect(content).toContain('{{handoff}}');
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
