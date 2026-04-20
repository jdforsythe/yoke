/**
 * Unit tests for parseGitRemoteUrl in src/server/github/remote-parse.ts.
 *
 * Coverage:
 *   - SSH: git@github.com:owner/repo.git
 *   - HTTPS: https://github.com/owner/repo.git
 *   - With and without .git suffix
 *   - Trailing slash variants
 *   - Case-insensitive host
 *   - Malformed / unrecognised URLs → null
 */

import { describe, it, expect } from 'vitest';
import { parseGitRemoteUrl } from '../../src/server/github/remote-parse.js';

describe('parseGitRemoteUrl — SSH format', () => {
  it('parses standard SSH URL with .git', () => {
    const result = parseGitRemoteUrl('git@github.com:owner/repo.git');
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses SSH URL without .git', () => {
    const result = parseGitRemoteUrl('git@github.com:owner/repo');
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses SSH URL with trailing slash', () => {
    const result = parseGitRemoteUrl('git@github.com:owner/repo.git/');
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses SSH URL without .git but with trailing slash', () => {
    const result = parseGitRemoteUrl('git@github.com:owner/repo/');
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('handles uppercase in SSH host (case-insensitive)', () => {
    const result = parseGitRemoteUrl('git@GitHub.COM:owner/repo.git');
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses SSH URL with hyphenated owner and repo', () => {
    const result = parseGitRemoteUrl('git@github.com:my-org/my-project.git');
    expect(result).toEqual({ owner: 'my-org', repo: 'my-project' });
  });

  it('parses SSH URL for non-github host (GitLab, etc.)', () => {
    const result = parseGitRemoteUrl('git@gitlab.com:acme/backend.git');
    expect(result).toEqual({ owner: 'acme', repo: 'backend' });
  });
});

describe('parseGitRemoteUrl — HTTPS format', () => {
  it('parses standard HTTPS URL with .git', () => {
    const result = parseGitRemoteUrl('https://github.com/owner/repo.git');
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses HTTPS URL without .git', () => {
    const result = parseGitRemoteUrl('https://github.com/owner/repo');
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses HTTPS URL with trailing slash', () => {
    const result = parseGitRemoteUrl('https://github.com/owner/repo.git/');
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses HTTPS URL without .git but with trailing slash', () => {
    const result = parseGitRemoteUrl('https://github.com/owner/repo/');
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('handles uppercase in HTTPS host (case-insensitive)', () => {
    const result = parseGitRemoteUrl('https://GitHub.COM/owner/repo.git');
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses HTTP (non-TLS) URL', () => {
    const result = parseGitRemoteUrl('http://github.com/owner/repo.git');
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses HTTPS URL with dotted owner/repo names', () => {
    const result = parseGitRemoteUrl('https://github.com/org.name/repo.name.git');
    expect(result).toEqual({ owner: 'org.name', repo: 'repo.name' });
  });
});

describe('parseGitRemoteUrl — malformed / unrecognised → null', () => {
  it('returns null for empty string', () => {
    expect(parseGitRemoteUrl('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseGitRemoteUrl('   ')).toBeNull();
  });

  it('returns null for a local file path', () => {
    expect(parseGitRemoteUrl('/home/user/projects/repo')).toBeNull();
  });

  it('returns null for a plain hostname with no path', () => {
    expect(parseGitRemoteUrl('https://github.com')).toBeNull();
  });

  it('returns null for a URL with only one path segment (no repo)', () => {
    expect(parseGitRemoteUrl('https://github.com/owner')).toBeNull();
  });

  it('returns null for a URL with three path segments', () => {
    // Extra path segment — not a valid remote format
    expect(parseGitRemoteUrl('https://github.com/owner/repo/extra')).toBeNull();
  });

  it('returns null for a malformed SSH URL (missing colon)', () => {
    expect(parseGitRemoteUrl('git@github.com/owner/repo.git')).toBeNull();
  });

  it('returns null for an arbitrary string', () => {
    expect(parseGitRemoteUrl('not-a-url-at-all')).toBeNull();
  });

  it('returns null for ftp:// scheme', () => {
    expect(parseGitRemoteUrl('ftp://github.com/owner/repo.git')).toBeNull();
  });
});
