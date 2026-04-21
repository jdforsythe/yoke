/**
 * Unit tests for src/server/worktree/branch.ts
 *
 * Covers:
 *   AC-1  Branch name matches yoke/<slug>-<shortid> pattern.
 *   RC-4  No path traversal possible through branch naming (slug contains
 *         only [a-z0-9-] — '/' and '..' are impossible in the slug).
 *
 * All tests are pure — no I/O, no filesystem, no child processes.
 */

import { describe, it, expect } from 'vitest';
import {
  slugify,
  makeShortId,
  makeBranchName,
  makeWorktreeDirName,
} from '../../src/server/worktree/branch.js';

// ---------------------------------------------------------------------------
// slugify()
// ---------------------------------------------------------------------------

describe('slugify()', () => {
  it('lowercases ASCII', () => {
    expect(slugify('AddAuth')).toBe('addauth');
  });

  it('converts spaces to hyphens', () => {
    expect(slugify('add auth')).toBe('add-auth');
  });

  it('collapses multiple non-alphanumeric chars to a single hyphen', () => {
    expect(slugify('add  auth!!!')).toBe('add-auth');
  });

  it('strips leading hyphens', () => {
    expect(slugify('!add-auth')).toBe('add-auth');
  });

  it('strips trailing hyphens', () => {
    expect(slugify('add-auth!')).toBe('add-auth');
  });

  it('handles a clean name unchanged', () => {
    expect(slugify('add-auth')).toBe('add-auth');
  });

  it('handles numbers', () => {
    expect(slugify('feature-42')).toBe('feature-42');
  });

  it('falls back to "workflow" for an empty input', () => {
    expect(slugify('')).toBe('workflow');
  });

  it('falls back to "workflow" for an all-symbol input', () => {
    expect(slugify('!!! ???')).toBe('workflow');
  });

  it('truncates slugs that exceed MAX_SLUG_LENGTH (40 chars)', () => {
    const longName = 'a'.repeat(80);
    const result = slugify(longName);
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).toBe('a'.repeat(40));
  });

  it('produces only [a-z0-9-] characters — no slash or dot traversal possible', () => {
    const suspicious = '../../etc/passwd';
    const slug = slugify(suspicious);
    // Every character is either a-z, 0-9, or '-'
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    // No path traversal characters
    expect(slug).not.toContain('/');
    expect(slug).not.toContain('.');
  });

  it('unicode non-ASCII characters are collapsed to hyphens', () => {
    const result = slugify('héllo wörld');
    expect(result).toMatch(/^[a-z0-9-]+$/);
  });
});

// ---------------------------------------------------------------------------
// makeShortId()
// ---------------------------------------------------------------------------

describe('makeShortId()', () => {
  it('strips UUID hyphens and takes the first 8 chars', () => {
    expect(makeShortId('550e8400-e29b-41d4-a716-446655440000')).toBe('550e8400');
  });

  it('handles a UUID with no hyphens (already stripped)', () => {
    expect(makeShortId('abcdef1234567890')).toBe('abcdef12');
  });

  it('returns the first 8 chars when the id is exactly 8 chars long', () => {
    expect(makeShortId('12345678')).toBe('12345678');
  });

  it('returns all chars when the id is shorter than 8 chars', () => {
    // Edge case: very short id — not expected in production but must not panic.
    expect(makeShortId('abc')).toBe('abc');
  });

  it('removes all hyphens before slicing', () => {
    // The UUID 'a-b-c-d-e' without hyphens is 'abcde' → first 8 = 'abcde'
    expect(makeShortId('a-b-c-d-e-f-g-h-i-j-k-l')).toBe('abcdefgh');
  });
});

// ---------------------------------------------------------------------------
// makeBranchName()
// ---------------------------------------------------------------------------

describe('makeBranchName()', () => {
  const id = '550e8400-e29b-41d4-a716-446655440000';

  it('produces the yoke/<slug>-<shortid> pattern', () => {
    expect(makeBranchName('add-auth', id)).toBe('yoke/add-auth-550e8400');
  });

  it('slugifies a human-readable workflow name', () => {
    expect(makeBranchName('Add Auth Feature!', id)).toBe('yoke/add-auth-feature-550e8400');
  });

  it('respects a custom prefix', () => {
    expect(makeBranchName('add-auth', id, 'feature/')).toBe('feature/add-auth-550e8400');
  });

  it('uses "workflow" as slug fallback for empty name', () => {
    expect(makeBranchName('', id)).toBe('yoke/workflow-550e8400');
  });

  it('contains no double slashes or path traversal characters', () => {
    const branch = makeBranchName('../../evil', id);
    // Should never contain '..'
    expect(branch).not.toContain('..');
    // Should be valid git branch characters
    expect(branch).toMatch(/^yoke\/[a-z0-9-]+-[a-z0-9]+$/);
  });
});

// ---------------------------------------------------------------------------
// makeWorktreeDirName()
// ---------------------------------------------------------------------------

describe('makeWorktreeDirName()', () => {
  const id = '550e8400-e29b-41d4-a716-446655440000';

  it('returns the full workflowId UUID as the directory name', () => {
    expect(makeWorktreeDirName(id)).toBe(id);
  });

  it('contains no "/" character — safe for filesystem use', () => {
    const dirName = makeWorktreeDirName(id);
    expect(dirName).not.toContain('/');
  });

  it('two different workflowIds produce different directory names', () => {
    const id2 = 'aabbccdd-0000-0000-0000-000000000000';
    expect(makeWorktreeDirName(id)).not.toBe(makeWorktreeDirName(id2));
  });

  it('branch name still includes uuid8 prefix for readability', () => {
    const branchName = makeBranchName('add-auth', id);
    // Branch keeps the slug-uuid8 format; dir uses full UUID (different shapes)
    expect(branchName).toBe('yoke/add-auth-550e8400');
    expect(makeWorktreeDirName(id)).toBe(id);
  });
});
