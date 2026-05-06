import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  checkNode,
  checkSqlite,
  checkGit,
  checkClaude,
  checkGitRepo,
  checkTemplatesPresent,
  checkTemplatesValid,
  runChecks,
  formatDoctorOutput,
  type GitExecutor,
  type GitRepoExecutor,
  type ClaudeExecutor,
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

/** Write a template to <tmpDir>/.yoke/templates/<name>.yml */
function writeTemplate(tmpDir: string, name: string, content: string): void {
  const templatesDir = path.join(tmpDir, '.yoke', 'templates');
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.writeFileSync(path.join(templatesDir, `${name}.yml`), content, 'utf8');
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
});

// ---------------------------------------------------------------------------
// checkSqlite()
// ---------------------------------------------------------------------------

describe('checkSqlite()', () => {
  it('opens an in-memory database', async () => {
    const result = await checkSqlite();
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkGit() — uses an injected executor for deterministic tests
// ---------------------------------------------------------------------------

describe('checkGit()', () => {
  it('passes for git 2.39.3', () => {
    const exec: GitExecutor = () => 'git version 2.39.3';
    const result = checkGit(exec);
    expect(result.passed).toBe(true);
    expect(result.message).toBe('git version 2.39.3');
  });

  it('fails for git 2.10', () => {
    const exec: GitExecutor = () => 'git version 2.10.0';
    const result = checkGit(exec);
    expect(result.passed).toBe(false);
    expect(result.remediation).toContain('git worktree');
  });

  it('fails when git is not installed', () => {
    const exec: GitExecutor = () => {
      throw new Error('ENOENT');
    };
    const result = checkGit(exec);
    expect(result.passed).toBe(false);
    expect(result.message).toContain('not found');
  });

  it('fails on unparseable version string', () => {
    const exec: GitExecutor = () => 'git version weird';
    const result = checkGit(exec);
    expect(result.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkClaude()
// ---------------------------------------------------------------------------

describe('checkClaude()', () => {
  it('passes when claude --version succeeds', () => {
    const exec: ClaudeExecutor = () => 'claude 1.2.3';
    const r = checkClaude(exec);
    expect(r.passed).toBe(true);
    expect(r.message).toContain('claude');
  });

  it('fails when claude is missing', () => {
    const exec: ClaudeExecutor = () => {
      throw new Error('ENOENT');
    };
    const r = checkClaude(exec);
    expect(r.passed).toBe(false);
    expect(r.remediation).toContain('Claude Code');
  });
});

// ---------------------------------------------------------------------------
// checkGitRepo()
// ---------------------------------------------------------------------------

describe('checkGitRepo()', () => {
  it('passes when executor succeeds', () => {
    const exec: GitRepoExecutor = () => undefined;
    const r = checkGitRepo('/some/dir', exec);
    expect(r.passed).toBe(true);
  });

  it('fails when executor throws', () => {
    const exec: GitRepoExecutor = () => {
      throw new Error('not a git repo');
    };
    const r = checkGitRepo('/some/dir', exec);
    expect(r.passed).toBe(false);
    expect(r.remediation).toContain('git init');
  });
});

// ---------------------------------------------------------------------------
// checkTemplatesPresent / checkTemplatesValid
// ---------------------------------------------------------------------------

describe('checkTemplatesPresent()', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = makeTmpDir();
    const promptsDir = path.join(tmpDir, '.yoke', 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'implement.md'), '# Implement\n', 'utf8');
  });
  afterEach(() => removeTmpDir(tmpDir));

  it('fails when no templates directory exists', () => {
    const r = checkTemplatesPresent(tmpDir);
    expect(r.passed).toBe(false);
    expect(r.remediation).toContain('yoke init');
  });

  it('passes when at least one template exists', () => {
    writeTemplate(tmpDir, 'default', MINIMAL_CONFIG);
    const r = checkTemplatesPresent(tmpDir);
    expect(r.passed).toBe(true);
    expect(r.message).toContain('default');
  });

  it('fails with migration_error when root .yoke.yml exists', () => {
    fs.writeFileSync(path.join(tmpDir, '.yoke.yml'), MINIMAL_CONFIG, 'utf8');
    const r = checkTemplatesPresent(tmpDir);
    expect(r.passed).toBe(false);
    expect(r.remediation).toContain('.yoke/templates/');
  });
});

describe('checkTemplatesValid()', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = makeTmpDir();
    const promptsDir = path.join(tmpDir, '.yoke', 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'implement.md'), '# Implement\n', 'utf8');
  });
  afterEach(() => removeTmpDir(tmpDir));

  it('produces one passing entry per valid template', () => {
    writeTemplate(tmpDir, 'default', MINIMAL_CONFIG);
    const results = checkTemplatesValid(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    expect(results[0].name).toContain('default');
  });

  it('flags missing prompt_template', () => {
    // Reference a prompt path that does not exist.
    const cfg = MINIMAL_CONFIG.replace(
      '.yoke/prompts/implement.md',
      '.yoke/prompts/nope.md',
    );
    writeTemplate(tmpDir, 'broken', cfg);
    const results = checkTemplatesValid(tmpDir);
    expect(results[0].passed).toBe(false);
    expect(results[0].remediation).toContain('prompt_template');
  });

  it('returns a failing entry on schema violation', () => {
    writeTemplate(tmpDir, 'broken', 'version: "1"\ntemplate:\n  name: x\n');
    const results = checkTemplatesValid(tmpDir);
    expect(results[0].passed).toBe(false);
  });

  it('flags a stage that references a phase not declared in top-level phases', () => {
    // Stage lists `["implement","review"]` but only `implement` is declared,
    // so `review` is a typo. The schema accepts this (arrays are open) — we
    // catch it in doctor's pipeline pass.
    const cfg = `version: "1"
template:
  name: typo-project
pipeline:
  stages:
    - id: build
      run: once
      phases:
        - implement
        - review
phases:
  implement:
    command: node
    args: []
    prompt_template: .yoke/prompts/implement.md
`;
    writeTemplate(tmpDir, 'typo', cfg);
    const results = checkTemplatesValid(tmpDir);
    expect(results[0].passed).toBe(false);
    expect(results[0].remediation).toMatch(/'review' is not declared/);
  });

  it('flags duplicate stage IDs in the pipeline', () => {
    const cfg = `version: "1"
template:
  name: dupe-project
pipeline:
  stages:
    - id: build
      run: once
      phases: [implement]
    - id: build
      run: once
      phases: [implement]
phases:
  implement:
    command: node
    args: []
    prompt_template: .yoke/prompts/implement.md
`;
    writeTemplate(tmpDir, 'dupe', cfg);
    const results = checkTemplatesValid(tmpDir);
    expect(results[0].passed).toBe(false);
    expect(results[0].remediation).toMatch(/duplicate stage id 'build'/);
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

  it('always includes the environment + template-discovery checks', async () => {
    writeTemplate(tmpDir, 'default', MINIMAL_CONFIG);
    const checks = await runChecks({ configDir: tmpDir });
    const names = checks.map((c) => c.name);
    expect(names).toContain('Node.js >= 20');
    expect(names).toContain('SQLite accessible');
    expect(names).toContain('git >= 2.20');
    expect(names).toContain('claude CLI on PATH');
    expect(names).toContain('git repository');
    expect(names).toContain('templates discovered');
    // Per-template entry too.
    expect(names.some((n) => n.startsWith("template '"))).toBe(true);
  });

  it('skips per-template checks when no template directory exists', async () => {
    const checks = await runChecks({ configDir: tmpDir });
    expect(checks.find((c) => c.name === 'templates discovered')!.passed).toBe(false);
    // No per-template entries when discovery failed.
    expect(checks.some((c) => c.name.startsWith("template '"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatDoctorOutput()
// ---------------------------------------------------------------------------

describe('formatDoctorOutput()', () => {
  it('formats PASS rows', () => {
    const out = formatDoctorOutput([
      { name: 'X', passed: true, message: 'ok' },
    ]);
    expect(out).toContain('[PASS] X');
    expect(out).toContain('ok');
  });

  it('formats FAIL rows with remediation prefixed by →', () => {
    const out = formatDoctorOutput([
      { name: 'X', passed: false, message: 'broken', remediation: 'do this\nthen that' },
    ]);
    expect(out).toContain('[FAIL] X');
    expect(out).toContain('→ do this');
    expect(out).toContain('→ then that');
  });
});
