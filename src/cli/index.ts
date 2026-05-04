/**
 * Yoke CLI entry point.
 *
 * Registers all subcommands via commander and dispatches to each handler
 * module. Each handler exports a `register(program)` function so the entry
 * point is thin and each subcommand is independently testable.
 *
 * Usage (when compiled / run via tsx):
 *   yoke init
 *   yoke start
 *   yoke status
 *   yoke cancel <workflowId>
 *   yoke doctor
 *   yoke record [fixture-path]
 */

import { createRequire } from 'node:module';
import { Command } from 'commander';
import { register as registerInit } from './init.js';
import { register as registerStart } from './start.js';
import { register as registerStatus } from './status.js';
import { register as registerCancel } from './cancel.js';
import { register as registerAck } from './ack.js';
import { register as registerDoctor } from './doctor.js';
import { register as registerRecord } from './record.js';
import { register as registerSetup } from './setup.js';

/** Read the package version from the installed package.json. */
function readPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('yoke')
    .description(
      'Yoke — Claude Code pipeline harness. Define multi-stage AI workflows in ' +
      '.yoke/templates/<name>.yml, run them with a live dashboard.',
    )
    .version(readPackageVersion(), '-V, --version', 'output the Yoke version')
    .addHelpText('after', `
Quick start:
  yoke setup                       # guided walkthrough (recommended for first-time users)
  yoke init --template one-shot    # scaffold a starter project
  yoke start                       # launch the dashboard

Common commands:
  yoke start              Run the pipeline engine + dashboard.
  yoke init               Scaffold a Yoke project (use --template <name> for starters).
  yoke setup              Drop into a guided Claude Code session for first-time setup.
  yoke doctor             Diagnose your environment (Node, git, claude, templates).
  yoke status             Show the running server's workflow + item state.
  yoke cancel <id>        Cancel a running workflow.

Documentation: https://github.com/jdforsythe/yoke
`);

  registerInit(program);
  registerStart(program);
  registerStatus(program);
  registerCancel(program);
  registerAck(program);
  registerDoctor(program);
  registerRecord(program);
  registerSetup(program);

  return program;
}

/**
 * Main entry called by the bin wrapper. Exits non-zero on unhandled error.
 */
export async function main(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}

// Auto-invoke when run as the entry point (tsx src/cli/index.ts or bin/yoke).
void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
