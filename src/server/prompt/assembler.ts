/**
 * Pure prompt assembler — (template, ctx) → string.
 *
 * This module is the public entry point for prompt construction.
 * It delegates pattern replacement to engine.ts and adds no I/O of its own.
 *
 * Non-responsibilities:
 *   - Does NOT read files (context.ts owns that).
 *   - Does NOT access SQLite.
 *   - Does NOT call git.
 *
 * Review criteria (feat-prompt-asm RC-1, RC-4):
 *   RC-1  No I/O inside this file; all context is passed in.
 *   RC-4  This file has complete pure-function test coverage via
 *         tests/prompt/assembler.test.ts without touching SQLite or FS.
 *
 * Acceptance criteria (feat-prompt-asm AC-2, AC-3, AC-5):
 *   AC-2  Missing template keys produce [MISSING:key] (delegated to engine).
 *   AC-3  All context is passed as a plain object; no DB or FS access.
 *   AC-5  Dry-run preview: call assemblePrompt without spawning anything
 *         and you get the full prompt string.
 */

export type { PromptContext } from './engine.js';
import { replaceTemplateVars } from './engine.js';
import type { PromptContext } from './engine.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assembles a prompt string from a template and a context.
 *
 * @param template     UTF-8 template string with {{variable}} tokens.
 * @param ctx          PromptContext produced by buildPromptContext().
 * @param options.templatePath   Informational path for diagnostics only.
 *                               Not used by the assembler itself.
 * @returns            The assembled prompt string.
 *
 * Missing keys produce [MISSING:key] markers in the output (AC-2).
 * The caller (Pipeline Engine) is responsible for validating the byte
 * length of the result before handing it to the Process Manager.
 */
export function assemblePrompt(
  template: string,
  ctx: PromptContext,
  options?: { templatePath?: string },
): string {
  void options; // templatePath is informational; reserved for future diagnostics
  return replaceTemplateVars(template, ctx);
}
