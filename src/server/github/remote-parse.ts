/**
 * Pure URL parser for git remote origin URLs.
 *
 * Handles SSH and HTTPS formats, with or without .git suffix and trailing
 * slash, case-insensitive on the host component.
 *
 * Never makes network calls — operates on the URL string only.
 */

export interface ParsedRemote {
  owner: string;
  repo: string;
}

/**
 * Parse a git remote origin URL into owner/repo components.
 *
 * Supported formats:
 *   SSH:   git@github.com:owner/repo.git
 *   HTTPS: https://github.com/owner/repo.git
 *   Both:  with or without trailing .git and/or trailing slash
 *   Host:  case-insensitive
 *
 * Returns null for any URL that cannot be parsed into owner/repo
 * (treated as 'unconfigured' — never throws).
 */
export function parseGitRemoteUrl(url: string): ParsedRemote | null {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  // SSH format: git@<host>:<owner>/<repo>[.git][/]
  const sshMatch = /^git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  // HTTPS format: https?://<host>/<owner>/<repo>[.git][/]
  const httpsMatch = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  return null;
}
