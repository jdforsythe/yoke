/**
 * yoke init — scaffold .yoke.yml and example prompt templates.
 *
 * Creates:
 *   .yoke.yml                        — minimal valid config
 *   .yoke/prompts/implement.md       — example implement phase prompt
 *   .yoke/prompts/plan.md            — example plan phase prompt
 *   .yoke/prompts/review.md          — example review phase prompt
 *
 * Acceptance criteria:
 *   AC-1: Creates files on opt-in (user runs the command).
 *   AC-2: Exits with an error if any target file already exists — never
 *         overwrites. This is a hard-coded pre-flight check, not a --force
 *         flag default (RC).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const YOKE_YML = `version: "1"

project:
  name: my-project

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

const IMPLEMENT_MD = `# Implement

You are an engineer implementing the task described below.

## Task
{{item}}

## Context
### Recent git log
{{git_log_recent}}

### Architecture
{{architecture}}

### Progress so far
{{progress}}

### Handoff from previous phase
{{handoff}}

## Instructions
- Implement the task completely.
- Write tests for every new code path that can fail.
- Do not modify files outside the scope of the task.
- When done, update progress.md with a one-paragraph summary.
`;

const PLAN_MD = `# Plan

You are an architect producing a detailed implementation plan.

## Task
{{item}}

## Context
### Architecture
{{architecture}}

### Recent git log
{{git_log_recent}}

## Instructions
- Produce a step-by-step plan in \`docs/plan.md\`.
- Identify acceptance criteria and edge cases.
- Note any ambiguities as open questions.
`;

const REVIEW_MD = `# Review

You are a reviewer checking an implementation for correctness and quality.

## Task
{{item}}

## Context
### Architecture
{{architecture}}

### Progress
{{progress}}

### Handoff
{{handoff}}

## Instructions
- Review the implementation against the acceptance criteria.
- Report findings as APPROVED, NEEDS_CHANGES, or BLOCKED.
- Update \`docs/review.md\` with your verdict and detailed findings.
`;

// ---------------------------------------------------------------------------
// Target file list
// ---------------------------------------------------------------------------

/** Files created by yoke init, relative to cwd. */
const TARGETS = [
  { rel: '.yoke.yml', content: YOKE_YML },
  { rel: path.join('.yoke', 'prompts', 'implement.md'), content: IMPLEMENT_MD },
  { rel: path.join('.yoke', 'prompts', 'plan.md'), content: PLAN_MD },
  { rel: path.join('.yoke', 'prompts', 'review.md'), content: REVIEW_MD },
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
      'Scaffold .yoke.yml and example prompt templates (never overwrites existing files)',
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
    });
}
