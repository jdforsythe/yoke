import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  checkNode,
  checkSqlite,
  checkGit,
  checkConfig,
  runChecks,
  formatDoctorOutput,
  type GitExecutor,
} from '../../src/cli/doctor.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-doctor-test-'));
}
function removeTmpDir(d: string): void {
  fs.rmSync(d, { recursive: true, force: true });
}

const MINIMAL_CONFIG = `version: "1"
project:
  name: test-project
pipeline:
  stages:
    - id: implement
      run: once
      phases:
        - implement
phases:
  implement:
    command: node
    args: []
    prompt_template: .yoke/prompts/implement.md
`;

// ---------------------------------------------------------------------------
// checkNode()
// ---------------------------------------------------------------------------

describe('checkNode()', () => {
  it('passes on the current Node.js (must be >= 20 in CI)', () => {
    const result = checkNode();
    // This test environment must use Node >= 20 — it will fail otherwise,
    // which is intentional: Yoke itself requires Node 20.
    expect(result.passed).toBe(true);
    expect(result.message).toContain('Node.js');
  });

  it('reports failure for Node 18', () => {
    // Temporarily override process.versions.node
    const original = process.versions.node;
    Object.defineProperty(process.versions, 'node', {
      configurable: true,
      value: '18.20.0',
    });
    try {
      const result = checkNode();
      expect(result.passed).toBe(false);
      expect(result.message).toContain('too old');
      expect(result.remediation).toContain('nvm install 20');
    } finally {
      Object.defineProperty(process.versions, 'node', {
        configurable: true,
        value: original,
      });
    }
  });

  it('passes for Node 20', () => {
    const original = process.versions.node;
    Object.defineProperty(process.versions, 'node', {
      configurable: true,
      value: '20.0.0',
    });
    try {
      expect(checkNode().passed).toBe(true);
    } finally {
      Object.defineProperty(process.versions, 'node', {
        configurable: true,
        value: original,
      });
    }
  });

  it('passes for Node 22', () => {
    const original = process.versions.node;
    Object.defineProperty(process.versions, 'node', {
      configurable: true,
      value: '22.1.0',
    });
    try {
      expect(checkNode().passed).toBe(true);
    } finally {
      Object.defineProperty(process.versions, 'node', {
        configurable: true,
        value: original,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// checkSqlite()
// ---------------------------------------------------------------------------

describe('checkSqlite()', () => {
  it('passes when better-sqlite3 can open :memory:', async () => {
    const result = await checkSqlite();
    expect(result.passed).toBe(true);
    expect(result.message).toContain(':memory:');
  });

  it('has actionable remediation text even on success path (structure check)', async () => {
    const result = await checkSqlite();
    // On success, no remediation needed.
    expect(result.remediation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// checkGit()
// ---------------------------------------------------------------------------

describe('checkGit()', () => {
  it('passes on the current git (must be >= 2.20 in CI)', () => {
    const result = checkGit();
    // If git is not installed or too old, this test will fail — matching the
    // doctor's own assertion about the environment.
    expect(result.passed).toBe(true);
    expect(result.message).toContain('git version');
  });

  it('detects git 2.19 as too old', () => {
    const stubExec: GitExecutor = () => 'git version 2.19.0';
    const result = checkGit(stubExec);
    expect(result.passed).toBe(false);
    expect(result.message).toContain('2.19');
    expect(result.remediation).toContain('2.20');
  });

  it('detects git not found', () => {
    const stubExec: GitExecutor = () => { throw new Error('spawn ENOENT'); };
    const result = checkGit(stubExec);
    expect(result.passed).toBe(false);
    expect(result.message).toContain('not found');
    expect(result.remediation).toContain('brew install git');
  });

  it('detects git 3.x as passing (major > 2)', () => {
    const stubExec: GitExecutor = () => 'git version 3.0.0';
    const result = checkGit(stubExec);
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkConfig()
// ---------------------------------------------------------------------------

describe('checkConfig()', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = makeTmpDir();
    // Prompt template so loadConfig resolves paths without error.
    const promptsDir = path.join(tmpDir, '.yoke', 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'implement.md'), '# Implement\n', 'utf8');
  });
  afterEach(() => removeTmpDir(tmpDir));

  it('passes for a valid .yoke.yml', () => {
    const configPath = path.join(tmpDir, '.yoke.yml');
    fs.writeFileSync(configPath, MINIMAL_CONFIG, 'utf8');
    const result = checkConfig(configPath);
    expect(result.passed).toBe(true);
    expect(result.message).toContain(configPath);
  });

  it('fails with not_found when file is missing', () => {
    const configPath = path.join(tmpDir, 'nonexistent.yml');
    const result = checkConfig(configPath);
    expect(result.passed).toBe(false);
    expect(result.remediation).toContain('yoke init');
  });

  it('fails with parse_error and actionable remediation for invalid YAML', () => {
    const configPath = path.join(tmpDir, '.yoke.yml');
    fs.writeFileSync(configPath, '{ this is: [bad yaml\n', 'utf8');
    const result = checkConfig(configPath);
    expect(result.passed).toBe(false);
    expect(result.remediation).toContain('indentation');
  });

  it('fails with version_error and actionable remediation', () => {
    const configPath = path.join(tmpDir, '.yoke.yml');
    fs.writeFileSync(configPath, 'version: "2"\nproject:\n  name: x\n', 'utf8');
    const result = checkConfig(configPath);
    expect(result.passed).toBe(false);
    expect(result.remediation).toContain('version: "1"');
  });

  it('fails with validation_error and schema reference remediation', () => {
    const configPath = path.join(tmpDir, '.yoke.yml');
    // Missing required fields.
    fs.writeFileSync(configPath, 'version: "1"\nproject:\n  name: x\n', 'utf8');
    const result = checkConfig(configPath);
    expect(result.passed).toBe(false);
    expect(result.remediation).toContain('schema');
  });
});

// ---------------------------------------------------------------------------
// runChecks() integration
// ---------------------------------------------------------------------------

describe('runChecks()', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = makeTmpDir();
    const promptsDir = path.join(tmpDir, '.yoke', 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'implement.md'), '# Implement\n', 'utf8');
  });
  afterEach(() => removeTmpDir(tmpDir));

  it('returns exactly 4 checks', async () => {
    const configPath = path.join(tmpDir, '.yoke.yml');
    fs.writeFileSync(configPath, MINIMAL_CONFIG, 'utf8');
    const checks = await runChecks({ configPath });
    expect(checks).toHaveLength(4);
  });

  it('check names include all four categories', async () => {
    const configPath = path.join(tmpDir, '.yoke.yml');
    fs.writeFileSync(configPath, MINIMAL_CONFIG, 'utf8');
    const checks = await runChecks({ configPath });
    const names = checks.map((c) => c.name);
    expect(names).toContain('Node.js >= 20');
    expect(names).toContain('SQLite accessible');
    expect(names).toContain('git >= 2.20');
    expect(names).toContain('.yoke.yml valid');
  });

  it('config check fails when no .yoke.yml', async () => {
    const checks = await runChecks({ configPath: path.join(tmpDir, '.yoke.yml') });
    const configCheck = checks.find((c) => c.name === '.yoke.yml valid')!;
    expect(configCheck.passed).toBe(false);
    // AC: actionable remediation text per failed check.
    expect(configCheck.remediation).toBeTruthy();
    expect(configCheck.remediation!.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// formatDoctorOutput()
// ---------------------------------------------------------------------------

describe('formatDoctorOutput()', () => {
  it('shows PASS for passing checks', () => {
    const checks = [{ name: 'Node.js >= 20', passed: true, message: 'Node.js 20.1.0' }];
    const out = formatDoctorOutput(checks);
    expect(out).toContain('[PASS]');
    expect(out).toContain('Node.js >= 20');
  });

  it('shows FAIL and remediation for failing checks', () => {
    const checks = [
      {
        name: 'git >= 2.20',
        passed: false,
        message: 'git version 2.18.0 (too old)',
        remediation: 'brew upgrade git',
      },
    ];
    const out = formatDoctorOutput(checks);
    expect(out).toContain('[FAIL]');
    expect(out).toContain('brew upgrade git');
    expect(out).toContain('→');
  });

  it('does not show remediation prefix for passing checks', () => {
    const checks = [{ name: 'SQLite accessible', passed: true, message: 'ok' }];
    const out = formatDoctorOutput(checks);
    expect(out).not.toContain('[FAIL]');
    expect(out).not.toContain('→');
  });
});
