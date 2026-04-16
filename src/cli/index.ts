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

import { Command } from 'commander';
import { register as registerInit } from './init.js';
import { register as registerStart } from './start.js';
import { register as registerStatus } from './status.js';
import { register as registerCancel } from './cancel.js';
import { register as registerAck } from './ack.js';
import { register as registerDoctor } from './doctor.js';
import { register as registerRecord } from './record.js';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('yoke')
    .description('Yoke AI agent pipeline harness')
    .version('0.0.1');

  registerInit(program);
  registerStart(program);
  registerStatus(program);
  registerCancel(program);
  registerAck(program);
  registerDoctor(program);
  registerRecord(program);

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
