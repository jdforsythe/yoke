/**
 * Branch name allocator for Yoke worktrees.
 *
 * Produces branch names following the yoke/<slug>-<shortid> pattern.
 *
 * - slugify()           — URL-safe slug from an arbitrary workflow name string.
 * - makeShortId()       — 8-char hex prefix extracted from a UUID workflow id.
 * - makeBranchName()    — composes slug + shortid with the configured prefix.
 * - makeWorktreeDirName() — same as the branch suffix but without the prefix,
 *                           safe for use as a filesystem directory name.
 *
 * All functions are pure — no I/O, no side effects, deterministic output.
 */

/** Maximum characters kept from the slugified workflow name. */
const MAX_SLUG_LENGTH = 40;

/**
 * Converts an arbitrary workflow name to a git-safe slug.
 *
 * Rules applied in order:
 *   1. Lowercase.
 *   2. Non-alphanumeric characters (including spaces) → single '-'.
 *   3. Collapse consecutive hyphens.
 *   4. Strip leading and trailing hyphens.
 *   5. Truncate to MAX_SLUG_LENGTH.
 *   6. Fall back to 'workflow' if the result is empty.
 *
 * @example slugify('Add Auth!')  → 'add-auth'
 * @example slugify('')           → 'workflow'
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH);
  return slug.length > 0 ? slug : 'workflow';
}

/**
 * Extracts an 8-character short identifier from a workflow UUID.
 *
 * Strips hyphens before slicing so the result is always 8 contiguous
 * hex characters regardless of UUID formatting.
 *
 * @example makeShortId('550e8400-e29b-41d4-a716-446655440000') → '550e8400'
 */
export function makeShortId(workflowId: string): string {
  return workflowId.replace(/-/g, '').slice(0, 8);
}

/**
 * Constructs a git branch name following the yoke/<slug>-<shortid> pattern.
 *
 * @param workflowName  Human-readable workflow name from ResolvedConfig.
 * @param workflowId    Workflow UUID stored in the database.
 * @param prefix        Branch prefix — defaults to 'yoke/'.
 *
 * @example
 *   makeBranchName('add-auth', '550e8400-e29b-41d4-a716-446655440000')
 *   // → 'yoke/add-auth-550e8400'
 */
export function makeBranchName(
  workflowName: string,
  workflowId: string,
  prefix = 'yoke/',
): string {
  const slug = slugify(workflowName);
  const shortId = makeShortId(workflowId);
  return `${prefix}${slug}-${shortId}`;
}

/**
 * Computes the worktree directory name for a given workflow.
 *
 * Mirrors the branch name suffix (strips the 'yoke/' prefix) so it is
 * safe for use as a filesystem directory name with no '/' characters.
 *
 * @example
 *   makeWorktreeDirName('add-auth', '550e8400-e29b-41d4-a716-446655440000')
 *   // → 'add-auth-550e8400'
 */
export function makeWorktreeDirName(workflowName: string, workflowId: string): string {
  const slug = slugify(workflowName);
  const shortId = makeShortId(workflowId);
  return `${slug}-${shortId}`;
}
