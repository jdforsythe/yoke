/**
 * Unit tests for GithubButton visibility rule.
 *
 * shouldShowCreatePrButton is a pure function of {workflowStatus, githubStatus}
 * that determines when the "Create PR" button should be shown.
 *
 * Imported from the plain .ts module (not the .tsx component) to satisfy root
 * tsc which has no JSX support.
 */

import { describe, it, expect } from 'vitest';
import { shouldShowCreatePrButton } from '../../src/web/src/components/GithubButton/githubButtonRules.js';

describe('shouldShowCreatePrButton', () => {
  // ---------------------------------------------------------------------------
  // Terminal + createable → true
  // ---------------------------------------------------------------------------

  it('returns true for completed + idle', () => {
    expect(shouldShowCreatePrButton('completed', 'idle')).toBe(true);
  });

  it('returns true for completed + failed', () => {
    expect(shouldShowCreatePrButton('completed', 'failed')).toBe(true);
  });

  it('returns true for completed_with_blocked + idle', () => {
    expect(shouldShowCreatePrButton('completed_with_blocked', 'idle')).toBe(true);
  });

  it('returns true for completed_with_blocked + failed', () => {
    expect(shouldShowCreatePrButton('completed_with_blocked', 'failed')).toBe(true);
  });

  it('returns true for abandoned + idle', () => {
    expect(shouldShowCreatePrButton('abandoned', 'idle')).toBe(true);
  });

  it('returns true for abandoned + failed', () => {
    expect(shouldShowCreatePrButton('abandoned', 'failed')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Non-terminal → false regardless of github status
  // ---------------------------------------------------------------------------

  it('returns false for in_progress + idle', () => {
    expect(shouldShowCreatePrButton('in_progress', 'idle')).toBe(false);
  });

  it('returns false for pending + idle', () => {
    expect(shouldShowCreatePrButton('pending', 'idle')).toBe(false);
  });

  it('returns false for pending_stage_approval + idle', () => {
    expect(shouldShowCreatePrButton('pending_stage_approval', 'idle')).toBe(false);
  });

  it('returns false for in_progress + failed', () => {
    expect(shouldShowCreatePrButton('in_progress', 'failed')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Terminal + non-createable github status → false
  // ---------------------------------------------------------------------------

  it('returns false for completed + created', () => {
    expect(shouldShowCreatePrButton('completed', 'created')).toBe(false);
  });

  it('returns false for completed + creating', () => {
    expect(shouldShowCreatePrButton('completed', 'creating')).toBe(false);
  });

  it('returns false for completed + disabled', () => {
    expect(shouldShowCreatePrButton('completed', 'disabled')).toBe(false);
  });

  it('returns false for completed + unconfigured', () => {
    expect(shouldShowCreatePrButton('completed', 'unconfigured')).toBe(false);
  });

  it('returns false for abandoned + created', () => {
    expect(shouldShowCreatePrButton('abandoned', 'created')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it('returns false when workflowStatus is unknown', () => {
    expect(shouldShowCreatePrButton('unknown_status', 'idle')).toBe(false);
  });

  it('returns false when githubStatus is unknown', () => {
    expect(shouldShowCreatePrButton('completed', 'unknown_state')).toBe(false);
  });
});
