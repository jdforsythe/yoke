/**
 * Pre/Post command action grammar — exit-code → ActionValue resolver.
 *
 * The ActionsMap (from PrePostCommand.actions) declares what to do for each
 * exit code the spawned command may produce.
 *
 * Resolution order:
 *   1. Exact match: exitCode.toString() key (e.g. "0", "1", "127")
 *   2. Wildcard:    "*" key
 *   3. null:        no match — caller must treat as an unhandled exit code
 *
 * Pure module; no I/O, no side effects.
 */

import type { ActionValue, ActionsMap } from '../../shared/types/config.js';

export type { ActionValue };

/**
 * Resolves an exit code to the declared ActionValue.
 *
 * @param actions   The actions map from PrePostCommand.actions.
 * @param exitCode  Numeric exit code from the spawned command.
 * @returns ActionValue if a match is found, null if no entry covers this code.
 */
export function resolveAction(actions: ActionsMap, exitCode: number): ActionValue | null {
  const key = exitCode.toString();
  if (Object.prototype.hasOwnProperty.call(actions, key)) return actions[key];
  if (Object.prototype.hasOwnProperty.call(actions, '*')) return actions['*'];
  return null;
}

/**
 * Returns true iff the action is the "continue" sentinel — the runner should
 * proceed to the next command in the array without involving the Pipeline Engine.
 */
export function isContinue(action: ActionValue): boolean {
  return action === 'continue';
}
