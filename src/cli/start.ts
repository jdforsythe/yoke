/**
 * yoke start — spawn the Yoke pipeline engine.
 *
 * 1. Loads and validates .yoke.yml via loadConfig (exits non-zero on failure).
 * 2. Opens the SQLite database under .yoke/yoke.db; runs forward-only migrations.
 * 3. Calls listenServer on 127.0.0.1 at the configured port (default 7777).
 * 4. Logs the server URL.
 * 5. Writes .yoke/server.json so that yoke status / yoke cancel can discover
 *    the running instance.
 * 6. Keeps the process alive (the server drives the event loop).
 *
 * Acceptance criteria:
 *   AC: Spawns the pipeline engine and logs the server URL.
 *   AC: Exits non-zero if config validation fails.
 *   RC: Handles ECONNREFUSED with a clear message (N/A here — start IS the server).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { loadConfig } from '../server/config/loader.js';
import { ConfigLoadError } from '../server/config/errors.js';
import { openDbPool, type DbPool } from '../server/storage/db.js';
import { applyMigrations } from '../server/storage/migrate.js';
import { listenServer } from '../server/api/server.js';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Path to the migrations directory, resolved relative to this source file. */
function migrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../server/storage/migrations');
}

// ---------------------------------------------------------------------------
// Public API (exported for testing)
// ---------------------------------------------------------------------------

export interface StartOptions {
  /** Path to the .yoke.yml config file. Default: <cwd>/.yoke.yml */
  configPath?: string;
  /** Server port. Default: 7777 */
  port?: number;
}

export interface StartHandle {
  url: string;
  db: DbPool;
  fastify: FastifyInstance;
  /** Clean shutdown: closes db + fastify. */
  close(): Promise<void>;
}

/**
 * Validate config, open DB, run migrations, start Fastify, return a handle.
 * Throws on config validation failure (caller should exit non-zero).
 * Exported for integration tests.
 */
export async function startServer(opts: StartOptions = {}): Promise<StartHandle> {
  const configPath = opts.configPath ?? path.join(process.cwd(), '.yoke.yml');
  const port = opts.port ?? 7777;

  // Load + validate config — throws ConfigLoadError on failure.
  const config = loadConfig(configPath);

  // Database lives under .yoke/ in the config directory.
  const yokeDir = path.join(config.configDir, '.yoke');
  fs.mkdirSync(yokeDir, { recursive: true });
  const dbPath = path.join(yokeDir, 'yoke.db');

  const db = openDbPool(dbPath);
  applyMigrations(db.writer, migrationsDir());

  // Start server.
  const fastify = await listenServer(db, { port });

  const addr = fastify.server.address();
  const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port;
  const url = `http://127.0.0.1:${actualPort}`;

  // Write server discovery file.
  const serverJson = path.join(yokeDir, 'server.json');
  fs.writeFileSync(serverJson, JSON.stringify({ url, pid: process.pid }), 'utf8');

  return {
    url,
    db,
    fastify,
    async close() {
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
        throw err;
      }

      console.log(`Yoke server running at ${handle.url}`);

      // Keep process alive. SIGINT / SIGTERM → graceful shutdown.
      async function shutdown(signal: string): Promise<never> {
        console.log(`\n${signal} received — shutting down...`);
        await handle.close();
        process.exit(0);
      }

      process.on('SIGINT', () => void shutdown('SIGINT'));
      process.on('SIGTERM', () => void shutdown('SIGTERM'));
    });
}
