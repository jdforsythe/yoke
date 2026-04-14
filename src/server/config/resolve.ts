/**
 * Pure config resolver — no I/O, no side effects.
 *
 * Accepts a RawConfig (straight from the YAML parser) and the absolute path
 * of the directory containing .yoke.yml, returns a ResolvedConfig with all
 * relative path fields converted to absolute paths.
 *
 * Resolved fields (relative → absolute, base = configDir):
 *   phases[*].prompt_template
 *   phases[*].cwd                          (if present)
 *   phases[*].output_artifacts[*].schema   (if present)
 *   worktrees.teardown.script              (if present)
 *
 * NOT resolved — runtime-relative to the worktree, unknown at load time:
 *   pipeline.stages[*].items_from
 *   phases[*].output_artifacts[*].path
 */

import path from 'node:path';
import type { RawConfig, ResolvedConfig } from '../../shared/types/config.js';

/**
 * Resolve all config-relative paths in `raw` to absolute paths.
 *
 * The original `raw` object is NOT mutated; a deep clone is made first.
 * `configDir` must be an absolute path (the directory containing .yoke.yml).
 */
export function resolveConfig(raw: Readonly<RawConfig>, configDir: string): ResolvedConfig {
  const clone = structuredClone(raw) as RawConfig;

  // Phase-level paths
  for (const phase of Object.values(clone.phases)) {
    phase.prompt_template = toAbsolute(phase.prompt_template, configDir);

    if (phase.cwd !== undefined) {
      phase.cwd = toAbsolute(phase.cwd, configDir);
    }

    if (phase.output_artifacts !== undefined) {
      for (const artifact of phase.output_artifacts) {
        if (artifact.schema !== undefined) {
          artifact.schema = toAbsolute(artifact.schema, configDir);
        }
      }
    }
  }

  // Worktree teardown hook script (hook path)
  if (clone.worktrees?.teardown?.script !== undefined) {
    clone.worktrees.teardown.script = toAbsolute(clone.worktrees.teardown.script, configDir);
  }

  return { ...clone, configDir };
}

/** Resolve `p` against `base` if relative; return absolute paths unchanged. */
function toAbsolute(p: string, base: string): string {
  return path.isAbsolute(p) ? p : path.resolve(base, p);
}
