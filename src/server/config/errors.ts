/**
 * Structured error types for the config loader.
 *
 * Every failure from loadConfig() is a ConfigLoadError; callers narrow
 * on `detail.kind` to handle specific failure classes rather than
 * pattern-matching error messages.
 */

/** Simplified AJV error shape retained on ConfigLoadError for programmatic use. */
export interface ValidationError {
  instancePath: string;
  schemaPath: string;
  message: string;
  params: Record<string, unknown>;
}

export type ConfigErrorDetail =
  | { kind: 'not_found'; message: string; path: string }
  | { kind: 'parse_error'; message: string }
  | { kind: 'version_error'; message: string; received: unknown }
  | { kind: 'validation_error'; message: string; errors: ValidationError[] };

/**
 * Thrown by loadConfig() for every failure class:
 *
 *   not_found        — file missing or unreadable (ENOENT, EACCES, …)
 *   parse_error      — empty file or YAML syntax error
 *   version_error    — missing `version` field or version !== "1"
 *   validation_error — AJV schema violation (unknown key, wrong type, …)
 */
export class ConfigLoadError extends Error {
  readonly detail: ConfigErrorDetail;

  constructor(detail: ConfigErrorDetail) {
    super(detail.message);
    this.name = 'ConfigLoadError';
    this.detail = detail;
    // Maintains proper prototype chain in transpiled environments.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
