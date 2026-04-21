/**
 * Unit tests for the ReviewPanel detection predicate (r3-03).
 *
 * Covers:
 *  - hasTaskToolUse: Task vs non-Task tool_call blocks
 *  - shouldUseReviewPanel: autodetection + explicit renderer override
 */

import { describe, it, expect } from 'vitest';
import { hasTaskToolUse, shouldUseReviewPanel } from '../../src/web/src/store/reviewPanelDetection';
import type { RenderBlock, ToolCallBlock } from '../../src/web/src/store/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolCallBlock(name: string, status: ToolCallBlock['status'] = 'running'): ToolCallBlock {
  return {
    type: 'tool_call',
    blockId: `tool-${name}`,
    sessionId: 'sess-1',
    toolUseId: `tool-${name}`,
    name,
    input: {},
    status,
  };
}

function textBlock(): RenderBlock {
  return {
    type: 'text',
    blockId: 'text-1',
    sessionId: 'sess-1',
    text: 'hello',
    frozen: false,
  };
}

// ---------------------------------------------------------------------------
// hasTaskToolUse
// ---------------------------------------------------------------------------

describe('hasTaskToolUse', () => {
  it('returns false for empty block list', () => {
    expect(hasTaskToolUse([])).toBe(false);
  });

  it('returns false for blocks with no tool_call', () => {
    expect(hasTaskToolUse([textBlock()])).toBe(false);
  });

  it('returns false for non-Task tool_call (Bash)', () => {
    expect(hasTaskToolUse([toolCallBlock('Bash')])).toBe(false);
  });

  it('returns false for non-Task tool_call (ReadFile)', () => {
    expect(hasTaskToolUse([toolCallBlock('ReadFile')])).toBe(false);
  });

  it('returns true when a Task tool_call is present', () => {
    expect(hasTaskToolUse([toolCallBlock('Task')])).toBe(true);
  });

  it('returns true when Task appears among other blocks', () => {
    const blocks: RenderBlock[] = [
      textBlock(),
      toolCallBlock('Bash'),
      toolCallBlock('Task'),
      toolCallBlock('ReadFile'),
    ];
    expect(hasTaskToolUse(blocks)).toBe(true);
  });

  it('returns true on first Task even if list is long', () => {
    const blocks: RenderBlock[] = [
      ...Array.from({ length: 10 }, (_, i) => toolCallBlock(`Tool${i}`)),
      toolCallBlock('Task'),
      ...Array.from({ length: 10 }, (_, i) => toolCallBlock(`Tool${i + 10}`)),
    ];
    expect(hasTaskToolUse(blocks)).toBe(true);
  });

  it('is case-sensitive — "task" (lowercase) does not match', () => {
    expect(hasTaskToolUse([toolCallBlock('task')])).toBe(false);
  });

  it('Task with status pending is still detected', () => {
    expect(hasTaskToolUse([toolCallBlock('Task', 'pending')])).toBe(true);
  });

  it('Task with status ok is still detected', () => {
    expect(hasTaskToolUse([toolCallBlock('Task', 'ok')])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shouldUseReviewPanel — autodetection
// ---------------------------------------------------------------------------

describe('shouldUseReviewPanel — autodetection (no override)', () => {
  it('returns false for empty blocks (no Task)', () => {
    expect(shouldUseReviewPanel([])).toBe(false);
  });

  it('returns false when only non-Task tool calls exist', () => {
    expect(shouldUseReviewPanel([toolCallBlock('Bash'), toolCallBlock('ReadFile')])).toBe(false);
  });

  it('returns true when a Task tool_use is present — phase name irrelevant', () => {
    // This covers AC-1: phase named "audit" with Task → ReviewPanel
    expect(shouldUseReviewPanel([toolCallBlock('Task')])).toBe(true);
  });

  it('returns false for "review"-named phase with no Task calls — AC-2', () => {
    // Phase name is not considered; absence of Task calls → LiveStreamPane
    expect(shouldUseReviewPanel([textBlock(), toolCallBlock('Bash')])).toBe(false);
  });

  it('undefined override falls through to autodetection', () => {
    expect(shouldUseReviewPanel([toolCallBlock('Task')], undefined)).toBe(true);
    expect(shouldUseReviewPanel([], undefined)).toBe(false);
  });

  it('null override falls through to autodetection', () => {
    expect(shouldUseReviewPanel([toolCallBlock('Task')], null)).toBe(true);
    expect(shouldUseReviewPanel([], null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldUseReviewPanel — explicit override takes precedence (RC-2)
// ---------------------------------------------------------------------------

describe('shouldUseReviewPanel — explicit renderer override (RC-2)', () => {
  it('renderer=review forces ReviewPanel even with no Task blocks', () => {
    expect(shouldUseReviewPanel([], 'review')).toBe(true);
    expect(shouldUseReviewPanel([textBlock()], 'review')).toBe(true);
    expect(shouldUseReviewPanel([toolCallBlock('Bash')], 'review')).toBe(true);
  });

  it('renderer=stream forces LiveStreamPane even when Task blocks are present', () => {
    expect(shouldUseReviewPanel([toolCallBlock('Task')], 'stream')).toBe(false);
    expect(shouldUseReviewPanel([toolCallBlock('Task'), toolCallBlock('Bash')], 'stream')).toBe(false);
  });

  it('renderer=review overrides an empty stream (no Task yet)', () => {
    expect(shouldUseReviewPanel([], 'review')).toBe(true);
  });
});
