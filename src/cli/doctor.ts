/**
 * yoke doctor — pre-flight checks for the Yoke environment.
 *
 * Checks:
 *   1. Node.js >= 20
 *   2. SQLite accessible (open an in-memory DB with better-sqlite3)
 *   3. git >= 2.20
 *   4. .yoke.yml present and valid (loadConfig)
 *
 * For each check prints a PASS / FAIL row with actionable remediation text
 * on failure (RC: "not just 'failed'").
 *
 * Exit code: 0 if all checks pass, 1 if any check fails.
 *
 * No shell-injection risk: git check uses execFileSync (no shell: true) and
 * passes no user-supplied arguments.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Command } from 'commander';
import { loadConfig } from '../server/config/loader.js';
import { ConfigLoadError } from '../server/config/errors.js';

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
  const raw = process.versions.node; // e.g. "20.11.0"
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
    // Import the module directly to verify the native addon loads.
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
        `Run: npm rebuild better-sqlite3\n` +
        `If that fails, ensure your Node.js version (node --version) matches\n` +
        `the version that was used when running npm install.`,
    };
  }
}

/** Injectable executor type for testability. */
export type GitExecutor = () => string;

/** Default executor: runs git --version with no shell (no injection risk). */
const defaultGitExecutor: GitExecutor = () =>
  execFileSync('git', ['--version'], { encoding: 'utf8' }).trim();

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

  // "git version 2.39.3" → match[1]=2, match[2]=39
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

/** 4. .yoke.yml valid */
export function checkConfig(configPath: string): DoctorCheck {
  try {
    loadConfig(configPath);
    return {
      name: '.yoke.yml valid',
      passed: true,
      message: `${configPath} loaded and validated`,
    };
  } catch (err) {
    if (err instanceof ConfigLoadError) {
      let remediation: string;
      switch (err.detail.kind) {
        case 'not_found':
          remediation = `Create ${configPath} by running: yoke init`;
          break;
        case 'parse_error':
          remediation =
            `Fix YAML syntax in ${configPath}.\n` +
            `Check for indentation errors or unquoted special characters.`;
          break;
        case 'version_error':
          remediation = `Set version: "1" (a quoted string) at the top of ${configPath}.`;
          break;
        case 'validation_error':
          remediation =
            `Fix the schema violations listed above in ${configPath}.\n` +
            `Refer to docs/design/schemas/yoke-config.schema.json for the full schema.`;
          break;
        default:
          remediation = `Review ${configPath} and fix the reported error.`;
      }
      return {
        name: '.yoke.yml valid',
        passed: false,
        message: err.message,
        remediation,
      };
    }
    return {
      name: '.yoke.yml valid',
      passed: false,
      message: `Unexpected error: ${(err as Error).message}`,
      remediation: `Check ${configPath} for issues.`,
    };
  }
}

// ---------------------------------------------------------------------------
// Run all checks
// ---------------------------------------------------------------------------

export interface RunChecksOptions {
  /** Path to .yoke.yml. Default: <cwd>/.yoke.yml */
  configPath?: string;
  cwd?: string;
}

/** Run all four doctor checks and return results. */
export async function runChecks(opts: RunChecksOptions = {}): Promise<DoctorCheck[]> {
  const cwd = opts.cwd ?? process.cwd();
  const configPath = opts.configPath ?? path.join(cwd, '.yoke.yml');

  const sqliteCheck = await checkSqlite();

  return [
    checkNode(),
    sqliteCheck,
    checkGit(),
    checkConfig(configPath),
  ];
}

// ---------------------------------------------------------------------------
// Printer
// ---------------------------------------------------------------------------

/** Format a list of DoctorCheck results as a human-readable table. */
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
    .description('Check Node >= 20, SQLite, git >= 2.20, and .yoke.yml validity')
    .option('-c, --config <path>', 'Path to .yoke.yml', '.yoke.yml')
    .action(async (opts: { config: string }) => {
      const configPath = path.resolve(opts.config);
      const checks = await runChecks({ configPath });

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
