/**
 * Artifact validator — AJV-based validation of declared output_artifacts.
 *
 * Source: feat-artifact-validators spec (docs/idea/yoke-features.json).
 *
 * ## Guarantees
 *
 *   AC-1  Each artifact with a schema is validated; missing required field →
 *         validator_fail with the AJV error path.
 *   AC-2  validator_fail payload includes artifactPath, schemaId, and the raw
 *         AJV error array (not toString'd).
 *   AC-3  validators_ok only when ALL declared artifacts pass.
 *   AC-4  Required artifact absent on disk → validator_fail, not uncaught ENOENT.
 *   AC-5  Each artifact validated independently; failures collected, not short-circuited.
 *   AC-6  AJV configured with verbose:true so errors include schemaPath and data.
 *
 * ## Non-responsibilities
 *
 *   - Does NOT cache compiled validators or schema file contents (RC-2).
 *   - Does NOT throw — always returns a typed result.
 */

import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, AnySchema } from 'ajv';
import type { OutputArtifact } from '../../shared/types/config.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Structured record for a single artifact that failed validation. */
export interface ArtifactFailure {
  /** The artifact path as declared in config (relative to worktree). */
  artifactPath: string;
  /**
   * Schema identifier: the `$id` from the schema document if present,
   * otherwise the absolute path to the schema file, or the artifact path
   * itself when no schema was configured (missing-file case).
   */
  schemaId: string;
  /** Full AJV error array (verbose mode: includes schemaPath and data). */
  errors: ErrorObject[];
}

export type ValidateArtifactsResult =
  | { kind: 'validators_ok' }
  | { kind: 'validator_fail'; failures: ArtifactFailure[] };

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Validate every artifact in `artifacts` against its declared JSON schema.
 *
 * Artifacts are processed independently — one failure does not stop the
 * others (AC-5).  All failures are collected and returned together.
 *
 * @param artifacts   - Phase output_artifacts array from ResolvedConfig.
 * @param worktreePath - Absolute path to the worktree root; artifact `path`
 *                       fields are resolved relative to this directory.
 */
export async function validateArtifacts(
  artifacts: OutputArtifact[],
  worktreePath: string,
): Promise<ValidateArtifactsResult> {
  const failures: ArtifactFailure[] = [];

  for (const artifact of artifacts) {
    const required = artifact.required !== false;
    const absoluteArtifactPath = path.resolve(worktreePath, artifact.path);

    // ------------------------------------------------------------------
    // Step 1: Check existence — AC-4: required missing → validator_fail
    // ------------------------------------------------------------------
    let fileContent: string;
    try {
      fileContent = fs.readFileSync(absoluteArtifactPath, 'utf8');
    } catch {
      if (required) {
        failures.push({
          artifactPath: artifact.path,
          schemaId: artifact.schema ?? artifact.path,
          errors: [
            {
              instancePath: '',
              schemaPath: '#',
              keyword: 'required',
              params: { missingProperty: artifact.path },
              message: `required artifact not found on disk: ${artifact.path}`,
            } as ErrorObject,
          ],
        });
      }
      // File absent — skip schema validation regardless of required.
      continue;
    }

    // ------------------------------------------------------------------
    // Step 2: If no schema configured, existence check alone is sufficient.
    // ------------------------------------------------------------------
    if (!artifact.schema) continue;

    // ------------------------------------------------------------------
    // Step 3: Parse artifact as JSON.
    // ------------------------------------------------------------------
    let data: unknown;
    try {
      data = JSON.parse(fileContent);
    } catch (err) {
      failures.push({
        artifactPath: artifact.path,
        schemaId: artifact.schema,
        errors: [
          {
            instancePath: '',
            schemaPath: '#',
            keyword: 'type',
            params: {},
            message: `artifact is not valid JSON: ${(err as Error).message}`,
          } as ErrorObject,
        ],
      });
      continue;
    }

    // ------------------------------------------------------------------
    // Step 4: Read schema file — no caching (RC-2: always re-read at
    //         validation time; schemas on disk may change between runs).
    // ------------------------------------------------------------------
    let schemaJson: AnySchema;
    try {
      // artifact.schema is absolute in ResolvedConfig (resolved at load time).
      const schemaContent = fs.readFileSync(artifact.schema, 'utf8');
      schemaJson = JSON.parse(schemaContent) as AnySchema;
    } catch (err) {
      failures.push({
        artifactPath: artifact.path,
        schemaId: artifact.schema,
        errors: [
          {
            instancePath: '',
            schemaPath: '#',
            keyword: 'schema',
            params: {},
            message: `schema file unreadable: ${(err as Error).message}`,
          } as ErrorObject,
        ],
      });
      continue;
    }

    // ------------------------------------------------------------------
    // Step 5: Validate with AJV.
    //   - New instance per artifact: guarantees no cross-run schema cache.
    //   - allErrors: true: collect every violation (AC-5 / AC-6).
    //   - verbose: true:   errors include `schema`, `parentSchema`, `data`
    //                      (the offending value) — satisfies AC-6.
    // ------------------------------------------------------------------
    const ajv = new Ajv2020({ allErrors: true, verbose: true });

    let valid: boolean;
    try {
      valid = ajv.validate(schemaJson, data) as boolean;
    } catch (err) {
      // AJV throws when the schema itself is invalid (bad $schema uri, etc.)
      failures.push({
        artifactPath: artifact.path,
        schemaId: artifact.schema,
        errors: [
          {
            instancePath: '',
            schemaPath: '#',
            keyword: 'schema',
            params: {},
            message: `schema compilation error: ${(err as Error).message}`,
          } as ErrorObject,
        ],
      });
      continue;
    }

    if (!valid && ajv.errors && ajv.errors.length > 0) {
      // Derive schemaId from the $id field if present (AC-2).
      const schemaId =
        typeof schemaJson === 'object' &&
        schemaJson !== null &&
        '$id' in schemaJson &&
        typeof (schemaJson as Record<string, unknown>)['$id'] === 'string'
          ? String((schemaJson as Record<string, unknown>)['$id'])
          : artifact.schema;

      failures.push({
        artifactPath: artifact.path,
        schemaId,
        errors: ajv.errors,
      });
    }
  }

  if (failures.length > 0) {
    return { kind: 'validator_fail', failures };
  }
  return { kind: 'validators_ok' };
}
