/**
 * Runtime detection predicate for ReviewPanel routing.
 *
 * Replaces the hardcoded phase-name check (phase === 'review' || 'pre_review')
 * with block-stream inspection: any session that produces a Task tool_use call
 * is treated as a review-style session and rendered in ReviewPanel.
 *
 * Priority:
 *   1. Explicit renderer override from phases[name].ui.renderer in yoke config
 *      (propagated via the session projection when available)
 *   2. Autodetect: any Task tool_use block present → ReviewPanel
 *   3. Default: LiveStreamPane
 */

import type { RenderBlock } from './types';

export type RendererOverride = 'review' | 'stream';

/**
 * Returns true when the block stream contains at least one Task tool_use call.
 * This is the autodetection predicate — phase name is irrelevant.
 */
export function hasTaskToolUse(blocks: readonly RenderBlock[]): boolean {
  return blocks.some((b) => b.type === 'tool_call' && (b as Extract<RenderBlock, { type: 'tool_call' }>).name === 'Task');
}

/**
 * Determines whether ReviewPanel or LiveStreamPane should render.
 *
 * @param blocks  Current block stream for the active session.
 * @param rendererOverride  Optional explicit override from phases[name].ui.renderer
 *   ('review' | 'stream'). Absent when the server has not yet projected this field.
 */
export function shouldUseReviewPanel(
  blocks: readonly RenderBlock[],
  rendererOverride?: RendererOverride | null,
): boolean {
  if (rendererOverride === 'review') return true;
  if (rendererOverride === 'stream') return false;
  return hasTaskToolUse(blocks);
}
