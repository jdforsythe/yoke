/**
 * PR creation adapters — AC-1 + AC-2.
 *
 * Two adapters share the same interface:
 *   OctokitAdapter  — calls the GitHub REST API via @octokit/rest
 *                     (requires a valid GITHUB_TOKEN)
 *   GhCliAdapter    — calls `gh pr create` via child_process
 *                     (uses whatever auth gh itself has)
 *
 * Both adapters accept the same PrInput and return PrResult.
 * The high-level service (service.ts) selects which adapter to use based on
 * the auth resolution result and falls back from Octokit to gh CLI on a 401.
 *
 * All external I/O is routed through the adapter interface so tests can stub
 * both paths without live GitHub API calls (AC-5, RC-2).
 */

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

export interface PrInput {
  owner: string;
  repo: string;
  /** Source branch (head). */
  head: string;
  /** Target branch (base). */
  base: string;
  title: string;
  body?: string;
}

export interface PrResult {
  prNumber: number;
  prUrl: string;
}

// ---------------------------------------------------------------------------
// Adapter interfaces
// ---------------------------------------------------------------------------

export interface OctokitAdapter {
  /**
   * Create a PR via the GitHub REST API.
   * Reject with an OctokitPrError on HTTP error or network failure.
   */
  createPr(token: string, input: PrInput): Promise<PrResult>;
}

export interface GhCliAdapter {
  /**
   * Create a PR via `gh pr create`.
   * Reject with an Error on non-zero exit.
   */
  createPr(input: PrInput): Promise<PrResult>;
}

// ---------------------------------------------------------------------------
// OctokitPrError — carries HTTP status for fallback logic
// ---------------------------------------------------------------------------

export class OctokitPrError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'OctokitPrError';
  }
}

// ---------------------------------------------------------------------------
// Production OctokitAdapter
// ---------------------------------------------------------------------------

/**
 * Creates a production OctokitAdapter backed by @octokit/rest.
 * Dynamically imported so tests that stub this adapter never load Octokit.
 */
export function makeOctokitAdapter(): OctokitAdapter {
  return {
    async createPr(token: string, input: PrInput): Promise<PrResult> {
      const { Octokit } = await import('@octokit/rest');
      const octokit = new Octokit({ auth: token });

      let response: Awaited<ReturnType<typeof octokit.rest.pulls.create>>;
      try {
        response = await octokit.rest.pulls.create({
          owner: input.owner,
          repo: input.repo,
          head: input.head,
          base: input.base,
          title: input.title,
          body: input.body ?? '',
        });
      } catch (err: unknown) {
        // @octokit/rest throws RequestError with a .status field on HTTP errors.
        const e = err as { status?: number; message?: string };
        const status = typeof e.status === 'number' ? e.status : 0;
        const message = e.message ?? String(err);
        throw new OctokitPrError(status, `GitHub API error ${status}: ${message}`);
      }

      return {
        prNumber: response.data.number,
        prUrl: response.data.html_url,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Production GhCliAdapter
// ---------------------------------------------------------------------------

/**
 * Creates a production GhCliAdapter that calls `gh pr create`.
 *
 * gh pr create has no --json flag (that's view/list only); on success it
 * prints the PR URL on stdout (possibly with preamble). We extract the last
 * GitHub pull URL from stdout and parse the trailing number out of it.
 */
const GH_PR_URL_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/g;

export function makeGhCliAdapter(): GhCliAdapter {
  return {
    async createPr(input: PrInput): Promise<PrResult> {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);

      const args = [
        'pr',
        'create',
        '--head', input.head,
        '--base', input.base,
        '--title', input.title,
        '--body', input.body ?? '',
        '--repo', `${input.owner}/${input.repo}`,
      ];

      let stdout: string;
      try {
        ({ stdout } = await execFileAsync('gh', args, { timeout: 30_000 }));
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
        const detail = e.stderr?.trim() || e.message;
        throw new Error(`gh pr create failed: ${detail}`);
      }

      const matches = [...stdout.matchAll(GH_PR_URL_RE)];
      const last = matches[matches.length - 1];
      if (!last) {
        throw new Error(`gh pr create: no PR URL in output: ${stdout.trim()}`);
      }
      return { prUrl: last[0], prNumber: Number(last[1]) };
    },
  };
}
