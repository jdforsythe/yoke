import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startServer, GitRepoRequiredError } from '../../src/cli/start.js';
import { ConfigLoadError } from '../../src/server/config/errors.js';

/** No-op git check: bypasses the git-repo guard for tests that run outside a git repo. */
const noopGitCheck = async (_dir: string): Promise<void> => { /* passthrough */ };

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-start-test-'));
}

function removeTmpDir(d: string): void {
  fs.rmSync(d, { recursive: true, force: true });
}

/** Write a template to <tmpDir>/.yoke/templates/default.yml */
function writeDefaultTemplate(tmpDir: string, content: string): void {
  const templatesDir = path.join(tmpDir, '.yoke', 'templates');
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.writeFileSync(path.join(templatesDir, 'default.yml'), content, 'utf8');
}

const MINIMAL_CONFIG = `version: "1"
template:
  name: test-project
pipeline:
  stages:
    - id: implement
      run: once
      phases:
        - implement
phases:
  implement:
    command: node
    args: []
    prompt_template: .yoke/prompts/implement.md
`;

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('yoke start — startServer()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    // Create a minimal prompt template so loadTemplate can resolve the path.
    const promptsDir = path.join(tmpDir, '.yoke', 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'implement.md'), '# Implement\n', 'utf8');
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  // AC: Exits non-zero if config validation fails. Here we verify the thrown
  // error is ConfigLoadError (the commander action exits 1 on this error).
  // Config errors are reported before the git check, so no _gitCheck override needed.
  it('throws ConfigLoadError when default template is missing', async () => {
    // No template file written — loadTemplate('default') will throw not_found.
    await expect(startServer({ configDir: tmpDir })).rejects.toBeInstanceOf(ConfigLoadError);
  });

  it('throws ConfigLoadError when default template has invalid content', async () => {
    writeDefaultTemplate(tmpDir, 'version: "1"\ntemplate: {}\n');
    await expect(startServer({ configDir: tmpDir })).rejects.toBeInstanceOf(ConfigLoadError);
  });

  it('throws ConfigLoadError with version mismatch', async () => {
    writeDefaultTemplate(tmpDir, 'version: "2"\ntemplate:\n  name: x\n');
    await expect(startServer({ configDir: tmpDir })).rejects.toBeInstanceOf(ConfigLoadError);
  });

  // AC-1: yoke start in a non-git directory exits non-zero with a message
  // naming the missing requirement (RC-1: check is in startServer; RC-2: message
  // includes configDir and the git command that failed).
  it('throws GitRepoRequiredError when configDir is not a git repository', async () => {
    writeDefaultTemplate(tmpDir, MINIMAL_CONFIG);
    // tmpDir is not a git repo — use the real default git check.
    const err = await startServer({ configDir: tmpDir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitRepoRequiredError);
    const gitErr = err as GitRepoRequiredError;
    // RC-2: message must include the configDir path.
    expect(gitErr.message).toContain(tmpDir);
    // RC-2: message must include the failing git command.
    expect(gitErr.message).toContain('git rev-parse --show-toplevel');
  });

  // AC-3: No change to behaviour inside a valid git repo.
  // Tests below use _gitCheck: noopGitCheck to avoid dependency on git-repo
  // state of the CI tmp directory (which is not guaranteed to be a git repo).

  // AC: spawns server and logs URL; writes server.json.
  it('starts server, writes server.json, and returns a valid URL', async () => {
    writeDefaultTemplate(tmpDir, MINIMAL_CONFIG);

    // Port 0 → OS-assigned port to avoid conflicts.
    const handle = await startServer({ configDir: tmpDir, port: 0, _gitCheck: noopGitCheck, noScheduler: true });

    try {
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      const serverJsonPath = path.join(tmpDir, '.yoke', 'server.json');
      expect(fs.existsSync(serverJsonPath)).toBe(true);

      const info = JSON.parse(fs.readFileSync(serverJsonPath, 'utf8')) as {
        url: string;
        pid: number;
      };
      expect(info.url).toBe(handle.url);
      expect(info.pid).toBe(process.pid);
    } finally {
      await handle.close();
    }
  });

  // AC: server is reachable at the returned URL.
  it('server responds to GET /api/workflows after start', async () => {
    writeDefaultTemplate(tmpDir, MINIMAL_CONFIG);

    const handle = await startServer({ configDir: tmpDir, port: 0, _gitCheck: noopGitCheck, noScheduler: true });

    try {
      const res = await fetch(`${handle.url}/api/workflows`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { workflows: unknown[] };
      expect(Array.isArray(body.workflows)).toBe(true);
    } finally {
      await handle.close();
    }
  });

  // close() removes server.json.
  it('close() removes server.json', async () => {
    writeDefaultTemplate(tmpDir, MINIMAL_CONFIG);

    const handle = await startServer({ configDir: tmpDir, port: 0, _gitCheck: noopGitCheck, noScheduler: true });
    const serverJsonPath = path.join(tmpDir, '.yoke', 'server.json');
    expect(fs.existsSync(serverJsonPath)).toBe(true);

    await handle.close();
    expect(fs.existsSync(serverJsonPath)).toBe(false);
  });
});
