/**
 * Template-directory config loader.
 *
 * Reads template files from <configDir>/.yoke/templates/*.yml.
 * Every public function checks for a root .yoke.yml and throws a
 * migration_error if found — the root-level file is no longer supported.
 *
 * Two public functions:
 *   listTemplates(configDir)       — cheap scan; tolerates invalid files
 *   loadTemplate(configDir, name)  — full validate + resolve for one template
 *
 * Both throw ConfigLoadError (never a raw Error) for every failure class:
 *   migration_error  — .yoke.yml at repo root (must be moved)
 *   not_found        — template file missing or unreadable
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

const SCHEMA_JSON = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')) as AnySchema;

const ajv = new Ajv2020({ allErrors: true });
const validate = ajv.compile(SCHEMA_JSON);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TemplateSummary {
  /** Template name (filename without .yml extension). */
  name: string;
  /** Human-readable description from template.description, or null. */
  description: string | null;
  /** Absolute path to the template file. */
  path: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List all *.yml files in <configDir>/.yoke/templates/ with their names and
 * descriptions. Reads descriptions cheaply via YAML parse (no AJV validation).
 * Invalid or unreadable files are skipped with a console.warn, not thrown.
 *
 * @throws ConfigLoadError(migration_error) if <configDir>/.yoke.yml exists.
 */
export function listTemplates(configDir: string): TemplateSummary[] {
  checkRootYokeYml(configDir);

  const templatesDir = path.join(configDir, '.yoke', 'templates');
  let files: string[];
  try {
    files = fs.readdirSync(templatesDir).filter((f) => f.endsWith('.yml'));
  } catch {
    return [];
  }

  const results: TemplateSummary[] = [];
  for (const file of files) {
    const filePath = path.join(templatesDir, file);
    try {
      const rawYaml = fs.readFileSync(filePath, 'utf8');
      const parsed = parseYaml(rawYaml) as Record<string, unknown> | null | undefined;
      const templateSection = parsed?.['template'] as Record<string, unknown> | undefined;
      const description = (templateSection?.['description'] as string | undefined) ?? null;
      const name = path.basename(file, '.yml');
      results.push({ name, description, path: filePath });
    } catch (err) {
      console.warn(`[yoke] Skipping template ${filePath}: ${(err as Error).message}`);
    }
  }
  return results;
}

/**
 * Load, validate, and resolve a single template by name.
 * Looks up <configDir>/.yoke/templates/<name>.yml.
 *
 * The returned ResolvedConfig.configDir is the repo root (= configDir),
 * not the template file's parent directory.
 *
 * @throws ConfigLoadError(migration_error) if <configDir>/.yoke.yml exists.
 * @throws ConfigLoadError(not_found)       if the template file is missing.
 * @throws ConfigLoadError(parse_error)     on empty / invalid YAML.
 * @throws ConfigLoadError(version_error)   on missing or wrong version.
 * @throws ConfigLoadError(validation_error) on AJV schema violations.
 */
export function loadTemplate(configDir: string, name: string): ResolvedConfig {
  checkRootYokeYml(configDir);

  const templatePath = path.join(configDir, '.yoke', 'templates', `${name}.yml`);

  let rawYaml: string;
  try {
    rawYaml = fs.readFileSync(templatePath, 'utf8');
  } catch (err) {
    throw new ConfigLoadError({
      kind: 'not_found',
      path: templatePath,
      message: `Template '${name}' not found at ${templatePath}: ${(err as NodeJS.ErrnoException).message}`,
    });
  }

  // configDir (repo root) is used for path resolution so prompt_template and
  // other relative paths resolve against the repo root, not the templates dir.
  return parseAndValidate(rawYaml, templatePath, configDir);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Throw a migration_error if <configDir>/.yoke.yml exists.
 * The root-level file is no longer supported as of t-03.
 */
function checkRootYokeYml(configDir: string): void {
  const rootYml = path.join(configDir, '.yoke.yml');
  if (fs.existsSync(rootYml)) {
    throw new ConfigLoadError({
      kind: 'migration_error',
      message:
        `.yoke.yml at repo root is no longer supported; ` +
        `move it to .yoke/templates/<name>.yml`,
    });
  }
}

/**
 * Parse YAML, version-check, AJV-validate, and resolve paths.
 * Used by loadTemplate after the file has been read.
 */
function parseAndValidate(rawYaml: string, sourcePath: string, configDir: string): ResolvedConfig {
  // 1. Parse YAML 1.2.
  let parsed: unknown;
  try {
    parsed = parseYaml(rawYaml);
  } catch (err) {
    throw new ConfigLoadError({
      kind: 'parse_error',
      message: `YAML parse error in ${sourcePath}: ${(err as Error).message}`,
    });
  }

  // 2. Reject empty / null documents.
  if (parsed === null || parsed === undefined) {
    throw new ConfigLoadError({
      kind: 'parse_error',
      message: `${sourcePath} is empty or contains only a null document`,
    });
  }

  // 3. Version pin check — runs before AJV so the error message is specific.
  if (typeof parsed !== 'object' || !('version' in (parsed as object))) {
    throw new ConfigLoadError({
      kind: 'version_error',
      received: undefined,
      message:
        `${sourcePath}: missing required field 'version'. ` +
        `This harness requires version: "1".`,
    });
  }
  const receivedVersion = (parsed as Record<string, unknown>)['version'];
  if (receivedVersion !== '1') {
    throw new ConfigLoadError({
      kind: 'version_error',
      received: receivedVersion,
      message:
        `${sourcePath}: version ${JSON.stringify(receivedVersion)} is not supported. ` +
        `This harness requires version: "1".`,
    });
  }

  // 4. AJV validation (additionalProperties: false everywhere in schema).
  const valid = validate(parsed);
  if (!valid) {
    const ajvErrors = validate.errors ?? [];
    throw new ConfigLoadError({
      kind: 'validation_error',
      message: formatAjvErrors(ajvErrors, sourcePath),
      errors: ajvErrors.map(toValidationError),
    });
  }

  // 5. Resolve relative paths — pure, no I/O.
  return resolveConfig(parsed as RawConfig, configDir);
}

function formatAjvErrors(errors: ErrorObject[], sourcePath: string): string {
  const lines = [`Config validation failed for ${sourcePath}:`];
  for (const err of errors) {
    const where = err.instancePath === '' ? '(root)' : err.instancePath;
    const offending = describeOffending(err);
    lines.push(`  • ${where}: ${err.message}${offending} (schema: ${err.schemaPath})`);
  }
  return lines.join('\n');
}

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
