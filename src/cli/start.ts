/**
 * yoke start — spawn the Yoke pipeline engine.
 *
 * 1. Loads and validates .yoke.yml via loadConfig (exits non-zero on failure).
 * 2. Opens the SQLite database under .yoke/yoke.db; runs forward-only migrations.
 * 3. Calls createServer on 127.0.0.1 at the configured port (default 7777).
 * 4. Logs the server URL.
 * 5. Writes .yoke/server.json so that yoke status / yoke cancel can discover
 *    the running instance.
 * 6. Creates and starts the Scheduler with production dependencies.
 * 7. Keeps the process alive. SIGINT / SIGTERM → graceful drain then exit.
 *
 * Acceptance criteria:
 *   AC: Spawns the pipeline engine and logs the server URL.
 *   AC: Exits non-zero if config validation fails.
 *   RC: Handles ECONNREFUSED with a clear message (N/A here — start IS the server).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { ExecFileException } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { loadConfig } from '../server/config/loader.js';
import { ConfigLoadError } from '../server/config/errors.js';
import { openDbPool, type DbPool } from '../server/storage/db.js';
import { applyMigrations } from '../server/storage/migrate.js';
import { createServer } from '../server/api/server.js';
import type { FastifyInstance } from 'fastify';
import { JigProcessManager } from '../server/process/jig-manager.js';
import { WorktreeManager } from '../server/worktree/manager.js';
import { runCommands } from '../server/prepost/runner.js';
import { buildPromptContext, type GitHelper } from '../server/prompt/context.js';
import { assemblePrompt } from '../server/prompt/assembler.js';
import { Scheduler, type PromptAssemblerFn } from '../server/scheduler/scheduler.js';
import { dispatchNotification } from '../server/notifications/dispatcher.js';
import { makeAckAttentionFn } from '../server/pipeline/ack-attention.js';
import type { ServerCallbacks } from '../server/api/server.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Git repository guard
// ---------------------------------------------------------------------------

/**
 * Thrown by startServer when config.configDir is not inside a git repository.
 * The commander action catches this and exits non-zero with a clear message.
 */
export class GitRepoRequiredError extends Error {
  readonly configDir: string;
  readonly gitCommand: string;

  constructor(configDir: string) {
    const cmd = 'git rev-parse --show-toplevel';
    super(
      `${configDir}: not a git repository (${cmd} failed).\n` +
      `Run 'git init' to initialize a repository, or run 'yoke start' ` +
      `from inside an existing git repository.`,
    );
    this.name = 'GitRepoRequiredError';
    this.configDir = configDir;
    this.gitCommand = cmd;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Default git-repo check: runs `git rev-parse --show-toplevel` in `dir`.
 * Throws GitRepoRequiredError if the directory is not inside a git repository.
 */
async function defaultGitRepoCheck(dir: string): Promise<void> {
  try {
    await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: dir });
  } catch (err) {
    // execFileAsync rejects with ExecFileException (ENOENT if git missing,
    // non-zero exit if not a git repo). Both cases mean we can't proceed.
    void (err as ExecFileException);
    throw new GitRepoRequiredError(dir);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Path to the migrations directory, resolved relative to this source file. */
function migrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../server/storage/migrations');
}

/**
 * Build a production GitHelper that runs git commands inside `repoRoot`.
 */
function makeGitHelper(repoRoot: string): GitHelper {
  return {
    async logRecent(n: number): Promise<string> {
      try {
        const { stdout } = await execFileAsync('git', ['log', '--oneline', `-${n}`], { cwd: repoRoot });
        return stdout.trim();
      } catch {
        return '';
      }
    },
    async diffRange(from: string, to: string): Promise<string> {
      try {
        const { stdout } = await execFileAsync('git', ['diff', from, to], { cwd: repoRoot });
        return stdout;
      } catch {
        return '';
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Public API (exported for testing)
// ---------------------------------------------------------------------------

export interface StartOptions {
  /** Path to the .yoke.yml config file. Default: <cwd>/.yoke.yml */
  configPath?: string;
  /** Server port. Default: 7777 */
  port?: number;
  /**
   * Override the git-repository check (injectable for tests).
   * Default: runs `git rev-parse --show-toplevel` in config.configDir.
   * Pass `async () => {}` in tests that need to bypass the check.
   */
  _gitCheck?: (dir: string) => Promise<void>;
}

export interface StartHandle {
  url: string;
  db: DbPool;
  fastify: FastifyInstance;
  scheduler: Scheduler;
  /** Clean shutdown: stops scheduler, closes db + fastify. */
  close(): Promise<void>;
}

/**
 * Validate config, open DB, run migrations, start Fastify + Scheduler.
 * Returns a handle for clean shutdown. Throws on config validation failure.
 * Exported for integration tests.
 */
export async function startServer(opts: StartOptions = {}): Promise<StartHandle> {
  const configPath = opts.configPath ?? path.join(process.cwd(), '.yoke.yml');
  const port = opts.port ?? 7777;
  const gitCheck = opts._gitCheck ?? defaultGitRepoCheck;

  // Load + validate config — throws ConfigLoadError on failure.
  const config = loadConfig(configPath);

  // Guard: config.configDir must be inside a git repository.
  // WorktreeManager requires a real git repo and will throw uninformative
  // errors without this early check (AC-1, RC-1, RC-2).
  await gitCheck(config.configDir);

  // Database lives under .yoke/ in the config directory.
  const yokeDir = path.join(config.configDir, '.yoke');
  fs.mkdirSync(yokeDir, { recursive: true });
  const dbPath = path.join(yokeDir, 'yoke.db');

  const db = openDbPool(dbPath);
  applyMigrations(db.writer, migrationsDir());

  // Start server — use createServer so we can access state.registry.
  // callbacks is mutated after createServer returns to wire in the real
  // ackAttention handler (which needs state.registry, only available
  // post-construction).  Route handlers read callbacks at request time so
  // this is safe: no HTTP request can arrive before fastify.listen() completes.
  const callbacks: ServerCallbacks = {};
  const { fastify, state } = await createServer(db, callbacks);
  await fastify.listen({ host: '127.0.0.1', port });

  const addr = fastify.server.address();
  const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port;
  const url = `http://127.0.0.1:${actualPort}`;

  // Wire the real ackAttention handler now that state.registry is available.
  // The handler uses the writer connection for the UPDATE and broadcasts a
  // workflow.update frame to subscribed WS clients (AC-1, AC-2, AC-3, RC-1).
  callbacks.ackAttention = makeAckAttentionFn(db.writer, (workflowId) => {
    state.registry.broadcast(workflowId, null, 'workflow.update', {
      attentionAcked: true,
    });
  });

  // Write server discovery file.
  const serverJson = path.join(yokeDir, 'server.json');
  fs.writeFileSync(serverJson, JSON.stringify({ url, pid: process.pid }), 'utf8');

  // --- Wire production Scheduler dependencies.

  const processManager = new JigProcessManager();
  const worktreeManager = new WorktreeManager({ repoRoot: config.configDir });

  const assemblePromptFn: PromptAssemblerFn = async (promptOpts) => {
    const git = makeGitHelper(promptOpts.worktreePath);

    const workflowRow = {
      id: promptOpts.workflowId,
      name: promptOpts.workflowName,
      current_stage: promptOpts.stageId,
    };

    const itemRow = promptOpts.itemId != null
      ? {
          id: promptOpts.itemId,
          data: promptOpts.itemData ?? '{}',
          status: promptOpts.itemStatus ?? 'in_progress',
          current_phase: promptOpts.itemCurrentPhase,
          retry_count: promptOpts.itemRetryCount,
          blocked_reason: promptOpts.itemBlockedReason,
        }
      : undefined;

    const ctx = await buildPromptContext({
      workflow: workflowRow,
      stage: { id: promptOpts.stageId, run: promptOpts.stageRun },
      item: itemRow,
      worktreePath: promptOpts.worktreePath,
      git,
    });

    // prompt_template is a path relative to the config directory.
    // Read the file content before handing it to the assembler.
    const templatePath = path.resolve(config.configDir, promptOpts.phaseConfig.prompt_template);
    const template = fs.readFileSync(templatePath, 'utf8');
    return assemblePrompt(template, ctx);
  };

  const scheduler = new Scheduler({
    db,
    config,
    processManager,
    worktreeManager,
    prepostRunner: runCommands,
    assemblePrompt: assemblePromptFn,
    broadcast: (workflowId, sessionId, frameType, payload) =>
      state.registry.broadcast(workflowId, sessionId, frameType, payload),
    notify: ({ workflowId, pendingAttentionRowId }) => {
      // Fire-and-forget: dispatch the requires_attention notification after
      // the pending_attention row is committed (AC-4, AC-5, feat-notifications).
      void dispatchNotification(
        { db, baseUrl: url },
        {
          severity: 'requires_attention',
          message: 'Action required',
          workflowId,
          pendingAttentionRowId,
        },
      );
    },
  });

  await scheduler.start();

  return {
    url,
    db,
    fastify,
    scheduler,
    async close() {
      await scheduler.stop();
      await fastify.close();
      db.close();
      // Remove discovery file on clean shutdown.
      try {
        fs.unlinkSync(serverJson);
      } catch {
        // Not fatal if already removed.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function register(program: Command): void {
  program
    .command('start')
    .description('Start the Yoke pipeline engine')
    .option('-c, --config <path>', 'Path to .yoke.yml', '.yoke.yml')
    .option('-p, --port <number>', 'Server port', '7777')
    .action(async (opts: { config: string; port: string }) => {
      const configPath = path.resolve(opts.config);
      const port = parseInt(opts.port, 10);

      let handle: StartHandle;
      try {
        handle = await startServer({ configPath, port });
      } catch (err) {
        if (err instanceof ConfigLoadError) {
          console.error(`Configuration error: ${err.message}`);
          process.exit(1);
        }
        if (err instanceof GitRepoRequiredError) {
          console.error(`Git repository required: ${err.message}`);
          process.exit(1);
        }
        throw err;
      }

      console.log(`Yoke server running at ${handle.url}`);

      // Keep process alive. SIGINT / SIGTERM → graceful drain then shutdown.
      async function shutdown(signal: string): Promise<never> {
        console.log(`\n${signal} received — shutting down...`);
        await handle.close();
        process.exit(0);
      }

      process.on('SIGINT', () => void shutdown('SIGINT'));
      process.on('SIGTERM', () => void shutdown('SIGTERM'));
    });
}
