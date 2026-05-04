/**
 * yoke setup — drop the user into a Claude Code session pre-loaded with the
 * `yoke-setup` skill. The skill guides them through producing a complete,
 * schema-valid `.yoke/templates/<name>.yml` plus prompts and gate scripts.
 *
 * Implementation:
 *   1. Resolve `skills/yoke-setup.md` from the package install location.
 *   2. spawn('claude', ['--append-system-prompt', <skill-content>], { stdio: 'inherit' })
 *      so the user lands in an interactive Claude session in their cwd with
 *      the skill content appended to Claude Code's system prompt.
 *
 * If `claude` is not on PATH, surface a friendly install hint and exit
 * non-zero.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';

// ---------------------------------------------------------------------------
// Skill discovery
// ---------------------------------------------------------------------------

/**
 * Locate `skills/yoke-setup.md`. Works in dev (run from the repo via tsx) and
 * after `npm install -g yoke` (file ships under the package root).
 */
export function resolveSkillPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/cli/setup.js → ../../skills/yoke-setup.md
  // src/cli/setup.ts  → ../../skills/yoke-setup.md
  return path.resolve(here, '..', '..', 'skills', 'yoke-setup.md');
}

// ---------------------------------------------------------------------------
// Claude detection
// ---------------------------------------------------------------------------

export interface ClaudeProbe {
  /** Whether `claude --version` exits 0. */
  ok: boolean;
}

/** Check whether the Claude Code CLI is on PATH. */
export function probeClaude(): ClaudeProbe {
  const r = spawnSync('claude', ['--version'], { stdio: 'ignore' });
  return { ok: r.status === 0 };
}

// ---------------------------------------------------------------------------
// Public types (testing)
// ---------------------------------------------------------------------------

export type SetupResult =
  | { ok: true; exitCode: number }
  | {
      ok: false;
      reason: 'claude_missing' | 'skill_missing' | 'spawn_failed';
      message: string;
    };

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunSetupDeps {
  probe?: () => ClaudeProbe;
  /** Spawn the claude subprocess. Returns the exit code (or null if killed). */
  spawnClaude?: (args: string[]) => Promise<number | null>;
  /** Override skill resolution (testing). */
  resolveSkill?: () => string;
}

/**
 * Run `yoke setup` end-to-end. Resolves the skill content, probes Claude, and
 * spawns an interactive Claude session with `--append-system-prompt`.
 */
export async function runSetup(deps: RunSetupDeps = {}): Promise<SetupResult> {
  const probe = deps.probe ?? probeClaude;
  const resolveSkill = deps.resolveSkill ?? resolveSkillPath;

  if (!probe().ok) {
    return {
      ok: false,
      reason: 'claude_missing',
      message:
        `'claude' was not found on your PATH.\n` +
        `Yoke setup runs inside an interactive Claude Code session.\n` +
        `Install Claude Code: https://docs.claude.com/en/docs/claude-code/setup\n` +
        `Then re-run: yoke setup`,
    };
  }

  const skillPath = resolveSkill();
  let skillContent: string;
  try {
    skillContent = fs.readFileSync(skillPath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      reason: 'skill_missing',
      message:
        `Could not read the yoke-setup skill at ${skillPath}:\n` +
        `  ${(err as Error).message}\n` +
        `If you installed Yoke from a tarball, the skill file may not have been ` +
        `included. Reinstall with 'npm install -g yoke'.`,
    };
  }

  const args = ['--append-system-prompt', skillContent];

  const spawnImpl =
    deps.spawnClaude ??
    ((argv: string[]): Promise<number | null> =>
      new Promise((resolve, reject) => {
        const child = spawn('claude', argv, { stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', (code) => resolve(code));
      }));

  try {
    const code = await spawnImpl(args);
    return { ok: true, exitCode: code ?? 0 };
  } catch (err) {
    return {
      ok: false,
      reason: 'spawn_failed',
      message: `Failed to launch claude: ${(err as Error).message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function register(program: Command): void {
  program
    .command('setup')
    .description(
      'Guided first-time setup. Launches an interactive Claude Code session with ' +
      'the yoke-setup skill appended so Claude can scaffold a complete workflow ' +
      'for you.',
    )
    .addHelpText('after', `
What this does:
  • Reads skills/yoke-setup.md from the installed Yoke package.
  • Spawns 'claude' in your current directory with that skill appended to the
    system prompt, so the model knows the current Yoke conventions.
  • You then describe what you want; Claude produces a working template,
    prompts, and scripts you can run with 'yoke start'.

Requirements:
  • Claude Code installed and on PATH (run 'claude --version' to verify).

Examples:
  yoke setup
`)
    .action(async () => {
      const result = await runSetup();
      if (!result.ok) {
        console.error(`Error: ${result.message}`);
        process.exit(1);
      }
      process.exit(result.exitCode);
    });
}
