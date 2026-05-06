/**
 * yoke doctor — pre-flight checks for the Yoke environment.
 *
 * Checks (in order, all surfaced even if earlier ones fail):
 *   1. Node.js >= 20
 *   2. SQLite accessible (open an in-memory DB with better-sqlite3)
 *   3. git >= 2.20
 *   4. claude CLI on PATH
 *   5. configDir is inside a git repository
 *   6. At least one .yoke/templates/*.yml exists, AND each one passes AJV
 *      validation, AND every prompt_template + scripted post: run path that
 *      it references actually exists on disk.
 *
 * Exit code: 0 if all checks pass, 1 if any check fails.
 *
 * No shell-injection risk: child processes use execFileSync (no shell: true)
 * and pass no user-supplied arguments.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { listTemplates, loadTemplate } from '../server/config/loader.js';
import { ConfigLoadError } from '../server/config/errors.js';
import type { ResolvedConfig } from '../shared/types/config.js';

// ---------------------------------------------------------------------------
// Check result type
// ---------------------------------------------------------------------------

export interface DoctorCheck {
  name: string;
  passed: boolean;
  /** Short summary of the result. */
  message: string;
  /** Actionable remediation text — only shown on failure. */
  remediation?: string;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/** 1. Node.js version >= 20 */
export function checkNode(): DoctorCheck {
  const raw = process.versions.node;
  const major = parseInt(raw.split('.')[0], 10);
  if (major >= 20) {
    return { name: 'Node.js >= 20', passed: true, message: `Node.js ${raw}` };
  }
  return {
    name: 'Node.js >= 20',
    passed: false,
    message: `Node.js ${raw} (too old)`,
    remediation:
      `Yoke requires Node.js 20 or later.\n` +
      `Install via https://nodejs.org/ or use nvm: nvm install 20`,
  };
}

/** 2. SQLite accessible via better-sqlite3 */
export async function checkSqlite(): Promise<DoctorCheck> {
  try {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');
    db.exec('SELECT 1');
    db.close();
    return {
      name: 'SQLite accessible',
      passed: true,
      message: 'better-sqlite3 opened :memory: successfully',
    };
  } catch (err) {
    return {
      name: 'SQLite accessible',
      passed: false,
      message: `better-sqlite3 failed: ${(err as Error).message}`,
      remediation:
        `better-sqlite3 requires a native build for your platform.\n` +
        `Run: pnpm rebuild better-sqlite3\n` +
        `If that fails, ensure your Node.js version (node --version) matches\n` +
        `the version that was used when running pnpm install.`,
    };
  }
}

export type GitExecutor = () => string;
const defaultGitExecutor: GitExecutor = () =>
  execFileSync('git', ['--version'], { encoding: 'utf8' }).trim();

export type GitRepoExecutor = (cwd: string) => void;
const defaultGitRepoExecutor: GitRepoExecutor = (cwd: string) => {
  execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
};

/** 3. git >= 2.20 */
export function checkGit(executor: GitExecutor = defaultGitExecutor): DoctorCheck {
  let rawVersion: string;
  try {
    rawVersion = executor();
  } catch {
    return {
      name: 'git >= 2.20',
      passed: false,
      message: 'git not found in PATH',
      remediation:
        `git is required. Install from https://git-scm.com/ or via your package manager.\n` +
        `macOS:  brew install git\n` +
        `Ubuntu: apt-get install git`,
    };
  }

  const match = rawVersion.match(/(\d+)\.(\d+)/);
  if (!match) {
    return {
      name: 'git >= 2.20',
      passed: false,
      message: `Could not parse git version string: ${rawVersion}`,
      remediation: `Update git to 2.20 or later.`,
    };
  }

  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  const meetsReq = major > 2 || (major === 2 && minor >= 20);

  if (meetsReq) {
    return { name: 'git >= 2.20', passed: true, message: rawVersion };
  }

  return {
    name: 'git >= 2.20',
    passed: false,
    message: `${rawVersion} (need >= 2.20)`,
    remediation:
      `git 2.20+ is required for git worktree support.\n` +
      `macOS:  brew upgrade git\n` +
      `Ubuntu: apt-get install git`,
  };
}

/** 4. claude CLI on PATH (Claude Code). */
export type ClaudeExecutor = () => string;
const defaultClaudeExecutor: ClaudeExecutor = () =>
  execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();

export function checkClaude(executor: ClaudeExecutor = defaultClaudeExecutor): DoctorCheck {
  try {
    const ver = executor();
    return {
      name: 'claude CLI on PATH',
      passed: true,
      message: ver || 'claude --version exited 0',
    };
  } catch {
    return {
      name: 'claude CLI on PATH',
      passed: false,
      message: 'claude not found in PATH',
      remediation:
        `Yoke phases shell out to the Claude Code CLI.\n` +
        `Install Claude Code: https://docs.claude.com/en/docs/claude-code/setup\n` +
        `Then run 'claude --version' to confirm.`,
    };
  }
}

/** 5. git repository at configDir */
export function checkGitRepo(
  configDir: string,
  executor: GitRepoExecutor = defaultGitRepoExecutor,
): DoctorCheck {
  const cmd = 'git rev-parse --show-toplevel';
  try {
    executor(configDir);
    return {
      name: 'git repository',
      passed: true,
      message: `${configDir} is inside a git repository`,
    };
  } catch {
    return {
      name: 'git repository',
      passed: false,
      message: `${configDir}: not a git repository (${cmd} failed)`,
      remediation:
        `Yoke requires a git repository at the config directory.\n` +
        `Run 'git init' in ${configDir} to initialize one, or run 'yoke' ` +
        `from inside an existing git repository.`,
    };
  }
}

// ---------------------------------------------------------------------------
// Template + reference checks
// ---------------------------------------------------------------------------

/**
 * 6a. List templates in .yoke/templates/ — at least one must exist for
 * `yoke start` to do anything.
 */
export function checkTemplatesPresent(configDir: string): DoctorCheck {
  let names: string[] = [];
  try {
    names = listTemplates(configDir).map((t) => t.name);
  } catch (err) {
    if (err instanceof ConfigLoadError) {
      return {
        name: 'templates discovered',
        passed: false,
        message: err.message,
        remediation:
          `Move ${configDir}/.yoke.yml to ${configDir}/.yoke/templates/<name>.yml\n` +
          `(see CHANGELOG for the format change).`,
      };
    }
    return {
      name: 'templates discovered',
      passed: false,
      message: `unexpected error: ${(err as Error).message}`,
    };
  }

  if (names.length === 0) {
    return {
      name: 'templates discovered',
      passed: false,
      message: `no .yml files found in ${path.join(configDir, '.yoke', 'templates')}`,
      remediation:
        `Create one with: yoke init --template one-shot\n` +
        `Or run the guided walkthrough: yoke setup`,
    };
  }

  return {
    name: 'templates discovered',
    passed: true,
    message: `${names.length} template(s): ${names.join(', ')}`,
  };
}

/**
 * 6b. For each template: AJV-validate, then verify every prompt_template
 * file exists, and every scripted post: run path that looks like a local
 * file (./scripts/foo.js, prompts/bar.md, …) actually resolves.
 */
export function checkTemplatesValid(configDir: string): DoctorCheck[] {
  let summaries: { name: string }[];
  try {
    summaries = listTemplates(configDir).map((t) => ({ name: t.name }));
  } catch {
    return []; // checkTemplatesPresent already reported this.
  }

  const results: DoctorCheck[] = [];
  for (const { name } of summaries) {
    const checkName = `template '${name}'`;
    let cfg: ResolvedConfig;
    try {
      cfg = loadTemplate(configDir, name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        name: checkName,
        passed: false,
        message: msg,
        remediation: `Fix the schema violations above. See schemas/yoke-config.schema.json.`,
      });
      continue;
    }

    const missing: string[] = [];

    // Prompt templates — already absolute after resolveConfig.
    for (const [phaseKey, phase] of Object.entries(cfg.phases)) {
      const promptPath = phase.prompt_template;
      if (!fs.existsSync(promptPath)) {
        missing.push(`phases.${phaseKey}.prompt_template → ${promptPath}`);
      }
    }

    // Scripted post: run paths.
    for (const [phaseKey, phase] of Object.entries(cfg.phases)) {
      const post = phase.post ?? [];
      for (const cmd of post) {
        const localFile = looksLikeLocalScriptArg(cmd.run);
        if (!localFile) continue;
        const abs = path.isAbsolute(localFile)
          ? localFile
          : path.resolve(configDir, localFile);
        if (!fs.existsSync(abs)) {
          missing.push(`phases.${phaseKey}.post[${cmd.name}].run → ${localFile}`);
        }
      }
    }

    // Pipeline-level static checks: every phase listed under a stage must
    // exist in the top-level `phases:` map; stage IDs must be unique.  Both
    // failures only manifest at runtime today (the workflow either skips the
    // phase or the scheduler crashes mid-tick), so surfacing them here saves
    // a real run.
    const phaseKeys = new Set(Object.keys(cfg.phases));
    const seenStageIds = new Set<string>();
    for (const stage of cfg.pipeline.stages) {
      if (seenStageIds.has(stage.id)) {
        missing.push(`pipeline.stages: duplicate stage id '${stage.id}'`);
      } else {
        seenStageIds.add(stage.id);
      }
      for (const phaseKey of stage.phases) {
        if (!phaseKeys.has(phaseKey)) {
          missing.push(
            `pipeline.stages[${stage.id}].phases: '${phaseKey}' is not declared ` +
            `under top-level phases`,
          );
        }
      }
    }

    if (missing.length > 0) {
      results.push({
        name: checkName,
        passed: false,
        message: `${missing.length} issue(s)`,
        remediation: missing.map((m) => `• ${m}`).join('\n'),
      });
    } else {
      results.push({
        name: checkName,
        passed: true,
        message: 'schema valid; pipeline references resolve; prompts and scripts exist',
      });
    }
  }
  return results;
}

/**
 * Return the local script path that `runArgs` references, or null if the
 * command is a binary lookup (e.g. ["pnpm", "test"]) or uses a directory
 * argument (e.g. ["node", "--test", "test/"]) we can't validate at static
 * time.
 *
 * Heuristic — both branches require the candidate to *look* like a script
 * file (i.e. end in a known executable extension) so we don't flag flag
 * arguments or directory targets:
 *   - argv[0] is node/bash/sh → next non-flag positional that has a script
 *     extension is the candidate. If that arg is preceded by another
 *     `--option` (e.g. `node --test test/`) skip it: it is the option's
 *     value, not a script path.
 *   - argv[0] itself contains a `/` and ends in a script extension.
 */
const SCRIPT_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.sh', '.py', '.rb'];
function hasScriptExtension(p: string): boolean {
  const lower = p.toLowerCase();
  return SCRIPT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function looksLikeLocalScriptArg(runArgs: ReadonlyArray<string>): string | null {
  if (runArgs.length === 0) return null;
  const head = runArgs[0];
  if (head === 'node' || head === 'bash' || head === 'sh') {
    for (let i = 1; i < runArgs.length; i++) {
      const a = runArgs[i];
      if (a.startsWith('-')) continue;
      // Previous arg was a `--flag` — this positional is the flag's value
      // (e.g. `node --test test/`), not a script. Skip.
      const prev = runArgs[i - 1];
      if (prev !== undefined && prev.startsWith('--') && !prev.includes('=')) {
        continue;
      }
      return hasScriptExtension(a) ? a : null;
    }
    return null;
  }
  if (head.includes('/') && !path.isAbsolute(head) && hasScriptExtension(head)) {
    return head;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Run all checks
// ---------------------------------------------------------------------------

export interface RunChecksOptions {
  configDir?: string;
  cwd?: string;
}

export async function runChecks(opts: RunChecksOptions = {}): Promise<DoctorCheck[]> {
  const cwd = opts.cwd ?? process.cwd();
  const configDir = opts.configDir ?? cwd;

  const sqliteCheck = await checkSqlite();
  const templatesPresent = checkTemplatesPresent(configDir);

  const checks: DoctorCheck[] = [
    checkNode(),
    sqliteCheck,
    checkGit(),
    checkClaude(),
    checkGitRepo(cwd),
    templatesPresent,
  ];

  if (templatesPresent.passed) {
    checks.push(...checkTemplatesValid(configDir));
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Printer
// ---------------------------------------------------------------------------

export function formatDoctorOutput(checks: DoctorCheck[]): string {
  const lines: string[] = [];
  for (const c of checks) {
    const icon = c.passed ? 'PASS' : 'FAIL';
    lines.push(`[${icon}] ${c.name}`);
    lines.push(`      ${c.message}`);
    if (!c.passed && c.remediation) {
      for (const line of c.remediation.split('\n')) {
        lines.push(`      → ${line}`);
      }
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function register(program: Command): void {
  program
    .command('doctor')
    .description('Diagnose Yoke environment: Node, SQLite, git, claude, templates.')
    .option('-d, --config-dir <path>', 'Repo root containing .yoke/ folder', '.')
    .addHelpText('after', `
Examples:
  yoke doctor
  yoke doctor --config-dir /path/to/project
`)
    .action(async (opts: { configDir: string }) => {
      const configDir = path.resolve(opts.configDir);
      const checks = await runChecks({ configDir });
      console.log(formatDoctorOutput(checks));
      const allPassed = checks.every((c) => c.passed);
      if (!allPassed) {
        console.log('\nSome checks failed. See remediation steps above.');
        process.exit(1);
      } else {
        console.log('\nAll checks passed.');
      }
    });
}
