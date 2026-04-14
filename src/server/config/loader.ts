/**
 * Synchronous .yoke.yml loader.
 *
 * Reads the file, parses YAML 1.2, performs a version pin check, validates
 * against yoke-config.schema.json via AJV, and resolves all relative paths to
 * absolute before returning. No async code paths — synchronous throughout to
 * match better-sqlite3 parity on the startup critical path.
 *
 * Throws ConfigLoadError (never a raw Error) for every failure class:
 *   not_found        — file missing or unreadable
 *   parse_error      — empty file or YAML syntax error
 *   version_error    — missing `version` field or version !== "1"
 *   validation_error — AJV schema violation (unknown key, wrong type, …)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, AnySchema } from 'ajv';
import { ConfigLoadError, type ValidationError } from './errors.js';
import { resolveConfig } from './resolve.js';
import type { RawConfig, ResolvedConfig } from '../../shared/types/config.js';

// ---------------------------------------------------------------------------
// AJV setup — compiled once at module initialisation, never mutated.
// ---------------------------------------------------------------------------

const SCHEMA_PATH = fileURLToPath(
  new URL('../../../docs/design/schemas/yoke-config.schema.json', import.meta.url),
);

// readFileSync here is not a violation of the "no I/O in resolver" rule;
// this is the loader, and the schema is infrastructure, not user data.
const SCHEMA_JSON = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')) as AnySchema;

// allErrors: true — report every violation, not just the first.
const ajv = new Ajv2020({ allErrors: true });
const validate = ajv.compile(SCHEMA_JSON);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load, validate, and resolve a .yoke.yml file synchronously.
 *
 * @param configPath — absolute or cwd-relative path to the .yoke.yml file.
 * @returns ResolvedConfig with all relative paths converted to absolute.
 * @throws ConfigLoadError on any failure (structured kind discriminant).
 */
export function loadConfig(configPath: string): ResolvedConfig {
  // 1. Read file — I/O lives here, not in the resolver.
  let rawYaml: string;
  try {
    rawYaml = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    throw new ConfigLoadError({
      kind: 'not_found',
      path: configPath,
      message: `Cannot read ${configPath}: ${(err as NodeJS.ErrnoException).message}`,
    });
  }

  // 2. Parse YAML 1.2.
  //    yaml@2.x defaults to YAML 1.2 — on/off/yes/no are strings, not bools.
  //    version: 1 (bare integer) parses as number 1, caught below.
  let parsed: unknown;
  try {
    parsed = parseYaml(rawYaml);
  } catch (err) {
    throw new ConfigLoadError({
      kind: 'parse_error',
      message: `YAML parse error in ${configPath}: ${(err as Error).message}`,
    });
  }

  // 3. Reject empty / null documents (yaml@2 returns undefined for blank input).
  if (parsed === null || parsed === undefined) {
    throw new ConfigLoadError({
      kind: 'parse_error',
      message: `${configPath} is empty or contains only a null document`,
    });
  }

  // 4. Version pin check — runs before AJV so the error message is specific.
  //    Review criterion: "names the current version and the received value."
  if (typeof parsed !== 'object' || !('version' in (parsed as object))) {
    throw new ConfigLoadError({
      kind: 'version_error',
      received: undefined,
      message:
        `${configPath}: missing required field 'version'. ` +
        `This harness requires version: "1".`,
    });
  }
  const receivedVersion = (parsed as Record<string, unknown>)['version'];
  if (receivedVersion !== '1') {
    throw new ConfigLoadError({
      kind: 'version_error',
      received: receivedVersion,
      message:
        `${configPath}: version ${JSON.stringify(receivedVersion)} is not supported. ` +
        `This harness requires version: "1".`,
    });
  }

  // 5. AJV validation (additionalProperties: false everywhere in schema).
  const valid = validate(parsed);
  if (!valid) {
    const ajvErrors = validate.errors ?? [];
    throw new ConfigLoadError({
      kind: 'validation_error',
      message: formatAjvErrors(ajvErrors, configPath),
      errors: ajvErrors.map(toValidationError),
    });
  }

  // 6. Resolve relative paths — pure, no I/O.
  const configDir = path.dirname(path.resolve(configPath));
  return resolveConfig(parsed as RawConfig, configDir);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Format AJV errors into a human-readable string that satisfies the
 * acceptance criterion: "include the schema path and the offending value."
 *
 * Each line includes:
 *   - instancePath (where in the data)
 *   - message (what went wrong)
 *   - offending property name (for additionalProperties) or expected value
 *   - schemaPath (pointer into the schema)
 */
function formatAjvErrors(errors: ErrorObject[], configPath: string): string {
  const lines = [`Config validation failed for ${configPath}:`];
  for (const err of errors) {
    const where = err.instancePath === '' ? '(root)' : err.instancePath;
    const offending = describeOffending(err);
    lines.push(`  • ${where}: ${err.message}${offending} (schema: ${err.schemaPath})`);
  }
  return lines.join('\n');
}

/**
 * Extract a short "offending value" description from AJV error params.
 * Handles the two most important cases:
 *   - additionalProperties: names the unknown key
 *   - const:                names the expected constant value
 */
function describeOffending(err: ErrorObject): string {
  if (err.keyword === 'additionalProperties') {
    const p = (err.params as { additionalProperty?: string }).additionalProperty;
    return p !== undefined ? `, offending property: "${p}"` : '';
  }
  if (err.keyword === 'const') {
    const v = (err.params as { allowedValue?: unknown }).allowedValue;
    return v !== undefined ? `, expected: ${JSON.stringify(v)}` : '';
  }
  return '';
}

function toValidationError(err: ErrorObject): ValidationError {
  return {
    instancePath: err.instancePath,
    schemaPath: err.schemaPath,
    message: err.message ?? 'unknown AJV error',
    params: err.params as Record<string, unknown>,
  };
}
