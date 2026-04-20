/**
 * GithubButton visibility rules — extracted from GithubButton.tsx so the
 * unit test can import without JSX support in the root tsc.
 *
 * GithubButton.tsx re-exports shouldShowCreatePrButton from here so the
 * public API is unchanged.
 */

/**
 * Pure function: returns true when the "Create PR" button should be shown.
 *
 * Rules:
 *   workflowStatus must be in the terminal set AND
 *   githubStatus must be in {idle, failed}
 *
 * Terminal statuses: completed, completed_with_blocked, abandoned
 * (no further workflow progress possible).
 */
export function shouldShowCreatePrButton(
  workflowStatus: string,
  githubStatus: string,
): boolean {
  const isTerminal =
    workflowStatus === 'completed' ||
    workflowStatus === 'completed_with_blocked' ||
    workflowStatus === 'abandoned';
  const isCreateable = githubStatus === 'idle' || githubStatus === 'failed';
  return isTerminal && isCreateable;
}
