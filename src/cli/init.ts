/**
 * yoke init — scaffold a Yoke project.
 *
 * Two modes:
 *
 *   1. `yoke init`                 → drops a single minimal default.yml so
 *                                    the user can edit-and-run.
 *   2. `yoke init --template NAME` → copies the bundled starter at
 *                                    templates-pack/<NAME>/ (yml + prompts +
 *                                    optional .claude/agents, schemas, scripts)
 *                                    into the current working directory.
 *
 * Acceptance criteria:
 *   AC-1: Creates files on opt-in (user runs the command).
 *   AC-2: Never overwrites existing files. If any target file exists, the
 *         command exits non-zero with a list of conflicts (RC: pre-flight,
 *         not a --force toggle by default).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';

// ---------------------------------------------------------------------------
// Bundled starter discovery
// ---------------------------------------------------------------------------

/**
 * Resolve the templates-pack/ directory.
 *
 * Works in three contexts:
 *   • dist build:   .../dist/cli/init.js     → ../../templates-pack
 *   • tsx dev:      .../src/cli/init.ts      → ../../templates-pack
 *   • npm install:  .../node_modules/yoke/dist/cli/init.js → up two
 *                                              dirs lands inside the package.
 */
function templatesPackDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // `../..` from src/cli or dist/cli lands at the package root.
  return path.resolve(here, '..', '..', 'templates-pack');
}

/** List the names of bundled starters (subdirs of templates-pack/). */
export function listBundledTemplates(): string[] {
  try {
    return fs
      .readdirSync(templatesPackDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Default (no --template) scaffold
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

/** Files the no-flag form of yoke init writes, relative to cwd. */
const DEFAULT_TARGETS = [
  {
    rel: path.join('.yoke', 'templates', 'default.yml'),
    content: DEFAULT_TEMPLATE_YML,
  },
];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InitError {
  code: 'already_exists' | 'unknown_template';
  message: string;
  /** Conflicting paths (already_exists), or available template names (unknown_template). */
  details?: string[];
}

export type InitResult =
  | { ok: true; created: string[] }
  | { ok: false; error: InitError };

// ---------------------------------------------------------------------------
// Default scaffold runner
// ---------------------------------------------------------------------------

/**
 * Run `yoke init` with no template flag: drop `.yoke/templates/default.yml`.
 * @returns Result discriminated union — never throws.
 */
export function runInit(cwd?: string): InitResult {
  const dir = cwd ?? process.cwd();
  const targets = DEFAULT_TARGETS.map((t) => ({ ...t, abs: path.join(dir, t.rel) }));

  for (const t of targets) {
    if (fs.existsSync(t.abs)) {
      return {
        ok: false,
        error: {
          code: 'already_exists',
          message: `${t.abs} already exists. yoke init never overwrites existing files.`,
          details: [t.abs],
        },
      };
    }
  }

  const created: string[] = [];
  for (const t of targets) {
    fs.mkdirSync(path.dirname(t.abs), { recursive: true });
    fs.writeFileSync(t.abs, t.content, 'utf8');
    created.push(t.abs);
  }
  return { ok: true, created };
}

// ---------------------------------------------------------------------------
// `--template <name>` scaffold runner
// ---------------------------------------------------------------------------

/**
 * Recursively walk a starter directory and yield (srcAbs, relFromStarter)
 * for every regular file.
 */
function* walkFiles(srcRoot: string, relPrefix = ''): Generator<{ src: string; rel: string }> {
  const entries = fs.readdirSync(srcRoot, { withFileTypes: true });
  for (const e of entries) {
    const srcAbs = path.join(srcRoot, e.name);
    const rel = path.join(relPrefix, e.name);
    if (e.isDirectory()) {
      yield* walkFiles(srcAbs, rel);
    } else if (e.isFile()) {
      yield { src: srcAbs, rel };
    }
  }
}

/**
 * Map a relative path inside templates-pack/<name>/ to its destination in the
 * project. The `yoke/` subdir becomes `.yoke/` so users get the dotted runtime
 * directory directly. README.md is kept at the top level — users probably want
 * to read it before running. Everything else is copied verbatim.
 */
function destRelFor(starterRel: string): string {
  if (starterRel === 'README.md') {
    return path.join('docs', 'templates', 'README.md');
  }
  if (starterRel.startsWith(`yoke${path.sep}`) || starterRel === 'yoke') {
    return `.${starterRel}`;
  }
  return starterRel;
}

/**
 * Copy the bundled starter at `templates-pack/<name>/` into `cwd`, never
 * overwriting existing files.
 *
 * @returns InitResult
 */
export function runInitTemplate(name: string, cwd?: string): InitResult {
  const dir = cwd ?? process.cwd();

  // Validate template name against bundled list.
  const available = listBundledTemplates();
  if (!available.includes(name)) {
    return {
      ok: false,
      error: {
        code: 'unknown_template',
        message:
          `Unknown template '${name}'. ` +
          `Available templates: ${available.length > 0 ? available.join(', ') : '(none bundled)'}`,
        details: available,
      },
    };
  }

  const srcRoot = path.join(templatesPackDir(), name);

  // Pre-flight: collect (src, dest) pairs and check for conflicts.
  const plan: Array<{ src: string; dest: string }> = [];
  const conflicts: string[] = [];
  for (const f of walkFiles(srcRoot)) {
    const dest = path.join(dir, destRelFor(f.rel));
    plan.push({ src: f.src, dest });
    if (fs.existsSync(dest)) {
      conflicts.push(dest);
    }
  }

  if (conflicts.length > 0) {
    return {
      ok: false,
      error: {
        code: 'already_exists',
        message:
          `${conflicts.length} file${conflicts.length === 1 ? '' : 's'} already exist. ` +
          `yoke init never overwrites existing files.`,
        details: conflicts,
      },
    };
  }

  // Apply plan.
  const created: string[] = [];
  for (const { src, dest } of plan) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    created.push(dest);
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
      'Scaffold a Yoke project. With no flag drops a minimal default.yml; with ' +
      '--template <name> copies a bundled starter.',
    )
    .option(
      '-t, --template <name>',
      'Bundled starter name (one-shot, plan-build, plan-build-review, ' +
      'brainstorm-plan-build-review, multi-reviewer, content-pipeline, marketing-pipeline)',
    )
    .addHelpText('after', `
Examples:
  yoke init                              # minimal default.yml only
  yoke init --template one-shot          # single-phase Claude run
  yoke init --template plan-build-review # plan + per-item implement + review

Run 'yoke doctor' afterwards to verify the scaffolded project is healthy.
`)
    .action((opts: { template?: string }) => {
      const result = opts.template
        ? runInitTemplate(opts.template)
        : runInit();

      if (!result.ok) {
        console.error(`Error: ${result.error.message}`);
        if (result.error.code === 'already_exists' && result.error.details) {
          for (const p of result.error.details.slice(0, 10)) {
            console.error(`  ${p}`);
          }
          if (result.error.details.length > 10) {
            console.error(`  …and ${result.error.details.length - 10} more`);
          }
        }
        process.exit(1);
      }

      const banner = opts.template
        ? `Initialized yoke project from template '${opts.template}':`
        : 'Initialized yoke project:';
      console.log(banner);
      const shown = result.created.slice(0, 25);
      for (const p of shown) {
        console.log(`  created ${p}`);
      }
      if (result.created.length > shown.length) {
        console.log(`  …and ${result.created.length - shown.length} more files`);
      }
      console.log('');
      console.log('Next steps:');
      if (opts.template) {
        console.log(`  1. Read docs/templates/README.md for an overview of '${opts.template}'.`);
        console.log('  2. Run: yoke doctor');
        console.log('  3. Run: yoke start');
      } else {
        console.log('  1. Edit .yoke/templates/default.yml to configure your workflow.');
        console.log('  2. Run: yoke start');
      }
      console.log('  4. Open the dashboard URL shown in the terminal.');
    });
}
