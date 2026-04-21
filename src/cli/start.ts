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
import { listTemplates, loadTemplate } from '../server/config/loader.js';
import { ConfigLoadError } from '../server/config/errors.js';
import { createWorkflow, makeProductionIngestDeps } from '../server/scheduler/ingest.js';
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
import { makeRetryItemsFn } from '../server/pipeline/retry-items.js';
import { makeControlExecutor } from '../server/pipeline/control-executor.js';
import { makeArchiveWorkflowFn } from '../server/pipeline/archive-workflow.js';
import { makeCreatePrExecutorFn } from '../server/pipeline/create-pr-executor.js';
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
  /**
   * Repo root containing the .yoke/ folder.
   * Default: process.cwd()
   * t-10 will add a --template flag to select a named template; for now
   * startServer always loads the 'default' template.
   */
  configDir?: string;
  /** Server port. Default: 7777 */
  port?: number;
  /**
   * Dev-only: construct the Scheduler but skip `scheduler.start()` so no items
   * advance. The API/WS serve the existing DB frozen — useful for manual UI
   * testing against real state without spawning a new execution run.
   */
  noScheduler?: boolean;
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
  /**
   * Broadcast a server frame to all WS clients subscribed to workflowId.
   * Exposed so tests and Playwright fixtures can inject frames without running
   * the full scheduler (e.g. live-attention.spec.ts).
   */
  broadcast(workflowId: string, sessionId: string | null, frameType: string, payload: unknown): void;
  /** Clean shutdown: stops scheduler, closes db + fastify. */
  close(): Promise<void>;
}

/**
 * Validate config, open DB, run migrations, start Fastify + Scheduler.
 * Returns a handle for clean shutdown. Throws on config validation failure.
 * Exported for integration tests.
 */
export async function startServer(opts: StartOptions = {}): Promise<StartHandle> {
  const configDir = opts.configDir ?? process.cwd();
  const port = opts.port ?? 7777;
  const gitCheck = opts._gitCheck ?? defaultGitRepoCheck;

  // Load + validate the 'default' template — throws ConfigLoadError on failure.
  // t-10 will wire a --template flag so the caller can select a named template.
  const config = loadTemplate(configDir, 'default');

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

  // ackAttention is wired after the scheduler is constructed (below) so its
  // callback can call scheduler.scheduleIndexUpdate to coalesce index updates.

  // Wire the retryItems handler so POST /api/workflows/:id/retry can fire
  // user_retry transitions via the pipeline engine (RC-3 — no writes in API layer).
  callbacks.retryItems = makeRetryItemsFn(db, (workflowId) => {
    state.registry.broadcast(workflowId, null, 'workflow.update', { retried: true });
  });

  // Wire the archiveWorkflow handler so POST /api/workflows/:id/archive|unarchive
  // can set/clear archived_at via the pipeline engine (RC-3 — no writes in API layer).
  callbacks.archiveWorkflow = makeArchiveWorkflowFn(db.writer, (workflowId) => {
    state.registry.broadcast(workflowId, null, 'workflow.update', { archived: true });
  });

  // Wire GET /api/templates: list available templates in .yoke/templates/.
  // Errors (e.g. missing directory) return an empty list rather than failing.
  callbacks.listTemplates = () => {
    try {
      return listTemplates(configDir).map((t) => ({
        name: t.name,
        description: t.description,
      }));
    } catch {
      return [];
    }
  };

  // Wire POST /api/workflows: load a template by name, create a workflow row.
  // The DB write is inside createWorkflow (RC-3). The broadcast is in the route handler.
  const ingestDeps = makeProductionIngestDeps();
  callbacks.createWorkflow = ({ templateName, name }) => {
    let templateConfig: import('../shared/types/config.js').ResolvedConfig;
    try {
      templateConfig = loadTemplate(configDir, templateName);
    } catch (err) {
      if (err instanceof ConfigLoadError) {
        if (err.detail.kind === 'not_found') {
          return { status: 'template_not_found' };
        }
        return { status: 'template_error', message: err.message };
      }
      throw err;
    }

    const { workflowId } = createWorkflow(db, templateConfig, { name }, ingestDeps);

    // Query existing workflows from the same template for the soft-collision hint.
    // template_name in the DB stores config.template.name (the YAML name), not the file name.
    const existingRows = db
      .reader()
      .prepare(
        'SELECT name FROM workflows WHERE template_name = ? AND id != ? ORDER BY created_at DESC',
      )
      .all(templateConfig.template.name, workflowId) as Array<{ name: string }>;

    return {
      status: 'created',
      workflowId,
      name,
      sameTemplateNames: existingRows.map((r) => r.name),
    };
  };

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
      stage: { id: promptOpts.stageId, run: promptOpts.stageRun, itemsFrom: promptOpts.stageItemsFrom },
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

  // Wire the control executor now that scheduler is constructed. It needs
  // scheduler.killSession to SIGTERM running sessions when a workflow is
  // cancelled (RC-3 — no writes in API layer; all state changes happen in
  // the engine-layer executor).
  // Now that scheduler is available, wire ackAttention to also schedule a
  // coalesced workflow.index.update so the sidebar unreadEvents badge updates.
  callbacks.ackAttention = makeAckAttentionFn(db.writer, (workflowId) => {
    state.registry.broadcast(workflowId, null, 'workflow.update', {
      attentionAcked: true,
    });
    scheduler.scheduleIndexUpdate(workflowId);
  });

  callbacks.controlExecutor = makeControlExecutor(
    db.writer,
    (sid) => scheduler.killSession(sid),
    (wfId, frameType, payload) =>
      state.registry.broadcast(wfId, null, frameType, payload),
    (wfId) => scheduler.scheduleIndexUpdate(wfId),
  );

  // Wire the createPr executor: POST /api/workflows/:id/github/create-pr.
  // The production createPrFn mirrors the scheduler's _triggerAutoPr path:
  // read workflow → push branch → create PR via service.ts.
  callbacks.createPrExecutor = makeCreatePrExecutorFn(
    db.writer,
    async (workflowId: string) => {
      const wf = db.writer
        .prepare('SELECT name, branch_name, worktree_path FROM workflows WHERE id = ?')
        .get(workflowId) as
        | { name: string; branch_name: string | null; worktree_path: string | null }
        | undefined;
      if (!wf?.branch_name || !wf?.worktree_path) {
        throw new Error(`workflow ${workflowId}: missing branch_name or worktree_path`);
      }

      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execAsync = promisify(execFile);

      // Resolve owner/repo from the remote URL.
      let ownerRepo: { owner: string; repo: string } | null = null;
      try {
        const { stdout } = await execAsync(
          'git',
          ['-C', wf.worktree_path, 'remote', 'get-url', 'origin'],
          { timeout: 10_000 },
        );
        const { parseGitRemoteUrl } = await import('../server/github/remote-parse.js');
        ownerRepo = parseGitRemoteUrl(stdout.trim());
      } catch {
        // falls through to error below
      }
      if (!ownerRepo) {
        throw new Error(`workflow ${workflowId}: could not resolve owner/repo from remote`);
      }

      // Build PR body.
      let recentCommits: string[] = [];
      try {
        const { stdout } = await execAsync(
          'git',
          ['-C', wf.worktree_path, 'log', '--format=%s', '-10'],
          { timeout: 10_000 },
        );
        recentCommits = stdout.trim().split('\n').filter(Boolean).slice(0, 10);
      } catch {
        // ignore
      }
      let lastHandoffNote: string | null = null;
      try {
        const handoffPath = path.join(config.configDir, 'handoff.json');
        if (fs.existsSync(handoffPath)) {
          const raw = fs.readFileSync(handoffPath, 'utf8');
          const data = JSON.parse(raw) as { entries?: unknown[] };
          const entries = Array.isArray(data.entries) ? data.entries : [];
          const last = [...entries].reverse().find((e: unknown) => {
            return typeof e === 'object' && e !== null && !(e as Record<string, unknown>)['harness_injected'];
          });
          if (last) {
            const note = (last as Record<string, unknown>)['note'];
            lastHandoffNote = typeof note === 'string' ? note : null;
          }
        }
      } catch {
        // ignore
      }
      const { buildPrBody } = await import('../server/github/pr-body.js');
      const body = buildPrBody({ workflowName: wf.name, recentCommits, lastHandoffNote });

      // Push branch.
      const { pushBranch, makeProductionPushDeps } = await import('../server/github/push.js');
      const pushDeps = makeProductionPushDeps();
      const pushResult = await pushBranch(wf.branch_name, wf.worktree_path, pushDeps);
      if (!pushResult.ok) {
        const { writeGithubState } = await import('../server/github/service.js');
        writeGithubState(
          db,
          workflowId,
          'failed',
          { error: { kind: 'api_failed', message: `git push failed: ${pushResult.rawStderr}` } },
          (wfId, frameType, payload) => state.registry.broadcast(wfId, null, frameType, payload),
        );
        throw new Error(`git push failed: ${pushResult.rawStderr}`);
      }

      // Create PR.
      const { createPr } = await import('../server/github/service.js');
      const { makeProductionAuthDeps } = await import('../server/github/auth.js');
      const { makeOctokitAdapter, makeGhCliAdapter } = await import('../server/github/pr.js');
      const ghBroadcast = (wfId: string, frameType: 'workflow.update', payload: unknown) =>
        state.registry.broadcast(wfId, null, frameType, payload);
      const result = await createPr(
        {
          workflowId,
          branchName: wf.branch_name,
          owner: ownerRepo.owner,
          repo: ownerRepo.repo,
          base: config.github?.pr_target_branch ?? 'main',
          title: wf.name,
          body,
        },
        {
          db,
          authDeps: makeProductionAuthDeps(),
          pushGuardDeps: { execGit: pushDeps.execGit },
          octokitAdapter: makeOctokitAdapter(),
          ghCliAdapter: makeGhCliAdapter(),
          broadcast: ghBroadcast,
        },
      );
      if (!result.ok) {
        throw new Error(
          result.error.kind === 'api_failed'
            ? result.error.message
            : result.error.attempts.map((a) => `${a.source}: ${a.reason}`).join('; '),
        );
      }
      return { prNumber: result.prNumber, prUrl: result.prUrl, usedPath: result.usedPath };
    },
  );

  if (!opts.noScheduler) {
    await scheduler.start();
  }

  return {
    url,
    db,
    fastify,
    scheduler,
    broadcast(workflowId: string, sessionId: string | null, frameType: string, payload: unknown) {
      state.registry.broadcast(workflowId, sessionId, frameType as import('../server/api/frames.js').ServerFrameType, payload);
    },
    async close() {
      // Always stop the scheduler: even when noScheduler:true the scheduler's
      // scheduleIndexUpdate can be triggered by the control executor, and its
      // debounce timers must be cleared before the DB is closed to prevent
      // "database connection is not open" errors in tests.
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
    .option('-d, --config-dir <path>', 'Repo root containing .yoke/ folder', '.')
    .option('-p, --port <number>', 'Server port', '7777')
    .option('--no-scheduler', 'Dev-only: serve the API/WS from the existing DB without starting the scheduler (no items advance)')
    .action(async (opts: { configDir: string; port: string; scheduler: boolean }) => {
      const configDir = path.resolve(opts.configDir);
      const port = parseInt(opts.port, 10);
      // commander maps --no-scheduler to opts.scheduler === false
      const noScheduler = opts.scheduler === false;

      let handle: StartHandle;
      try {
        handle = await startServer({ configDir, port, noScheduler });
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
      if (noScheduler) {
        console.log('Scheduler disabled (--no-scheduler): no items will advance.');
      }

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
