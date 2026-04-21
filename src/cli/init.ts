/**
 * yoke init — scaffold .yoke/templates/default.yml.
 *
 * Creates:
 *   .yoke/templates/default.yml  — minimal valid template the user edits
 *
 * Acceptance criteria:
 *   AC-1: Creates the file on opt-in (user runs the command).
 *   AC-2: Exits with an error if the target file already exists — never
 *         overwrites. This is a hard-coded pre-flight check, not a --force
 *         flag default (RC).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';

// ---------------------------------------------------------------------------
// Template content
// ---------------------------------------------------------------------------

const DEFAULT_TEMPLATE_YML = `version: "1"

template:
  name: my-workflow
  description: "A single-phase workflow (edit this)"

pipeline:
  stages:
    - id: implement
      run: once
      phases:
        - implement

phases:
  implement:
    command: claude
    args:
      - "--output-format"
      - "stream-json"
      - "--verbose"
    prompt_template: .yoke/prompts/implement.md
`;

// ---------------------------------------------------------------------------
// Target file list
// ---------------------------------------------------------------------------

/** Files created by yoke init, relative to cwd. */
const TARGETS = [
  {
    rel: path.join('.yoke', 'templates', 'default.yml'),
    content: DEFAULT_TEMPLATE_YML,
  },
];

// ---------------------------------------------------------------------------
// Public API (exported for testing)
// ---------------------------------------------------------------------------

export interface InitError {
  code: 'already_exists';
  path: string;
  message: string;
}

export type InitResult =
  | { ok: true; created: string[] }
  | { ok: false; error: InitError };

/**
 * Run yoke init: check no target exists, then create all files.
 *
 * @param cwd  Directory to scaffold in (default: process.cwd()).
 * @returns    Result discriminated union — never throws.
 */
export function runInit(cwd?: string): InitResult {
  const dir = cwd ?? process.cwd();
  const targets = TARGETS.map((t) => ({ ...t, abs: path.join(dir, t.rel) }));

  // Pre-flight: any existing file is an unconditional error.
  for (const t of targets) {
    if (fs.existsSync(t.abs)) {
      return {
        ok: false,
        error: {
          code: 'already_exists',
          path: t.abs,
          message: `${t.abs} already exists. yoke init never overwrites existing files.`,
        },
      };
    }
  }

  // Create all files.
  const created: string[] = [];
  for (const t of targets) {
    fs.mkdirSync(path.dirname(t.abs), { recursive: true });
    fs.writeFileSync(t.abs, t.content, 'utf8');
    created.push(t.abs);
  }

  return { ok: true, created };
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function register(program: Command): void {
  program
    .command('init')
    .description(
      'Scaffold .yoke/templates/default.yml (never overwrites existing files)',
    )
    .action(() => {
      const result = runInit();
      if (!result.ok) {
        console.error(`Error: ${result.error.message}`);
        process.exit(1);
      }
      console.log('Initialized yoke project:');
      for (const p of result.created) {
        console.log(`  created ${p}`);
      }
      console.log('');
      console.log('Next steps:');
      console.log('  1. Edit .yoke/templates/default.yml to configure your workflow.');
      console.log('  2. Run: yoke start');
      console.log('  3. Open the dashboard URL shown in the terminal.');
      console.log('  4. Pick a template, name your workflow, and click Run.');
    });
}
