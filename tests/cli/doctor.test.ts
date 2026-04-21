import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  checkNode,
  checkSqlite,
  checkGit,
  checkGitRepo,
  checkConfig,
  runChecks,
  formatDoctorOutput,
  type GitExecutor,
  type GitRepoExecutor,
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

/** Write a template to <tmpDir>/.yoke/templates/default.yml */
function writeDefaultTemplate(tmpDir: string, content: string): void {
  const templatesDir = path.join(tmpDir, '.yoke', 'templates');
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.writeFileSync(path.join(templatesDir, 'default.yml'), content, 'utf8');
}

const MINIMAL_CONFIG = `version: "1"
template:
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
    expect(result.passed).toBe(true);
    expect(result.message).toContain('Node.js');
  });

  it('reports failure for Node 18', () => {
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
    expect(result.remediation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// checkGit()
// ---------------------------------------------------------------------------

describe('checkGit()', () => {
  it('passes on the current git (must be >= 2.20 in CI)', () => {
    const result = checkGit();
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
// checkGitRepo()
// ---------------------------------------------------------------------------

describe('checkGitRepo()', () => {
  it('passes when the directory is inside a git repository', () => {
    const passExec: GitRepoExecutor = (_cwd: string) => { /* success */ };
    const result = checkGitRepo('/some/repo', passExec);
    expect(result.passed).toBe(true);
    expect(result.name).toBe('git repository');
    expect(result.message).toContain('/some/repo');
  });

  it('fails when the directory is not a git repository', () => {
    const failExec: GitRepoExecutor = (_cwd: string) => {
      throw new Error('fatal: not a git repository');
    };
    const result = checkGitRepo('/tmp/not-a-repo', failExec);
    expect(result.passed).toBe(false);
    expect(result.name).toBe('git repository');
    expect(result.message).toContain('/tmp/not-a-repo');
    expect(result.message).toContain('git rev-parse --show-toplevel');
    expect(result.remediation).toBeTruthy();
    expect(result.remediation).toContain('git init');
  });

  it('fails when git is not found', () => {
    const noGitExec: GitRepoExecutor = (_cwd: string) => {
      const err = new Error('spawn ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    };
    const result = checkGitRepo('/tmp/dir', noGitExec);
    expect(result.passed).toBe(false);
    expect(result.remediation).toContain('git init');
  });

  it('passes against the real process.cwd() (must be inside a git repo in CI)', () => {
    const result = checkGitRepo(process.cwd());
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
    // Prompt template so loadTemplate resolves paths without error.
    const promptsDir = path.join(tmpDir, '.yoke', 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'implement.md'), '# Implement\n', 'utf8');
  });
  afterEach(() => removeTmpDir(tmpDir));

  it('passes for a valid default template', () => {
    writeDefaultTemplate(tmpDir, MINIMAL_CONFIG);
    const result = checkConfig(tmpDir);
    expect(result.passed).toBe(true);
    expect(result.message).toContain(tmpDir);
  });

  it('fails with not_found when template file is missing', () => {
    const result = checkConfig(tmpDir);
    expect(result.passed).toBe(false);
    expect(result.remediation).toContain('yoke init');
  });

  it('fails with migration_error when root .yoke.yml exists', () => {
    fs.writeFileSync(path.join(tmpDir, '.yoke.yml'), MINIMAL_CONFIG, 'utf8');
    const result = checkConfig(tmpDir);
    expect(result.passed).toBe(false);
    expect(result.remediation).toContain('.yoke/templates/');
  });

  it('fails with parse_error and actionable remediation for invalid YAML', () => {
    writeDefaultTemplate(tmpDir, '{ this is: [bad yaml\n');
    const result = checkConfig(tmpDir);
    expect(result.passed).toBe(false);
    expect(result.remediation).toContain('indentation');
  });

  it('fails with version_error and actionable remediation', () => {
    writeDefaultTemplate(tmpDir, 'version: "2"\ntemplate:\n  name: x\n');
    const result = checkConfig(tmpDir);
    expect(result.passed).toBe(false);
    expect(result.remediation).toContain('version: "1"');
  });

  it('fails with validation_error and schema reference remediation', () => {
    writeDefaultTemplate(tmpDir, 'version: "1"\ntemplate:\n  name: x\n');
    const result = checkConfig(tmpDir);
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

  it('returns exactly 5 checks', async () => {
    writeDefaultTemplate(tmpDir, MINIMAL_CONFIG);
    const checks = await runChecks({ configDir: tmpDir });
    expect(checks).toHaveLength(5);
  });

  it('check names include all five categories', async () => {
    writeDefaultTemplate(tmpDir, MINIMAL_CONFIG);
    const checks = await runChecks({ configDir: tmpDir });
    const names = checks.map((c) => c.name);
    expect(names).toContain('Node.js >= 20');
    expect(names).toContain('SQLite accessible');
    expect(names).toContain('git >= 2.20');
    expect(names).toContain('git repository');
    expect(names).toContain('.yoke/templates valid');
  });

  it('config check fails when no default template exists', async () => {
    const checks = await runChecks({ configDir: tmpDir });
    const configCheck = checks.find((c) => c.name === '.yoke/templates valid')!;
    expect(configCheck.passed).toBe(false);
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
