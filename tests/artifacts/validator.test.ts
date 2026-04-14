/**
 * Unit tests for src/server/artifacts/validator.ts
 *
 * Coverage:
 *   AC-1  Schema validation: missing required field → validator_fail with AJV path.
 *   AC-2  validator_fail payload has artifactPath, schemaId, raw ErrorObject[].
 *   AC-3  validators_ok only when ALL artifacts pass; one failure suppresses it.
 *   AC-4  Required artifact absent on disk → validator_fail (not uncaught ENOENT).
 *   AC-5  Each artifact independent: second artifact validated even if first fails.
 *   AC-6  AJV errors include schemaPath and offending value (verbose mode).
 *   RC-1  errors are raw ErrorObject[] (not toString'd strings).
 *   RC-2  No schema caching: modifying schema file between calls changes behaviour.
 *   RC-3  Missing required → validator_fail; missing non-required → skipped.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateArtifacts } from '../../src/server/artifacts/validator.js';
import type { OutputArtifact } from '../../src/shared/types/config.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-artifact-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a JSON file under tmpDir and return its absolute path. */
function writeJson(relPath: string, data: unknown): string {
  const abs = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(data), 'utf8');
  return abs;
}

/** Write a raw string file under tmpDir and return its absolute path. */
function writeRaw(relPath: string, content: string): string {
  const abs = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

/** Simple JSON Schema requiring a `name` string property. */
const SCHEMA_NAME_REQUIRED = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://example.com/schemas/name-required',
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string' },
  },
  additionalProperties: false,
};

/** JSON Schema that validates a non-empty array. */
const SCHEMA_NON_EMPTY_ARRAY = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://example.com/schemas/non-empty-array',
  type: 'array',
  minItems: 1,
};

// ---------------------------------------------------------------------------
// Helper: build an OutputArtifact pointing to files under tmpDir.
// Note: artifact.schema must be absolute (ResolvedConfig contract).
// ---------------------------------------------------------------------------

function makeArtifact(opts: {
  relPath: string;
  schemaAbsPath?: string;
  required?: boolean;
}): OutputArtifact {
  return {
    path: opts.relPath,
    schema: opts.schemaAbsPath,
    required: opts.required,
  };
}

// ---------------------------------------------------------------------------
// AC-3 / happy path: all valid → validators_ok
// ---------------------------------------------------------------------------

describe('validators_ok — all artifacts pass', () => {
  it('returns validators_ok when no artifacts declared', async () => {
    const result = await validateArtifacts([], tmpDir);
    expect(result.kind).toBe('validators_ok');
  });

  it('returns validators_ok for a valid artifact with matching schema', async () => {
    writeJson('output.json', { name: 'hello' });
    const schemaPath = writeJson('name.schema.json', SCHEMA_NAME_REQUIRED);

    const result = await validateArtifacts(
      [makeArtifact({ relPath: 'output.json', schemaAbsPath: schemaPath })],
      tmpDir,
    );
    expect(result.kind).toBe('validators_ok');
  });

  it('returns validators_ok for artifact with no schema (existence-only check)', async () => {
    writeJson('output.json', { anything: true });

    const result = await validateArtifacts(
      [makeArtifact({ relPath: 'output.json' })],
      tmpDir,
    );
    expect(result.kind).toBe('validators_ok');
  });

  it('returns validators_ok for multiple artifacts all passing', async () => {
    writeJson('a.json', { name: 'foo' });
    writeJson('b.json', [1, 2, 3]);
    const schemaN = writeJson('name.schema.json', SCHEMA_NAME_REQUIRED);
    const schemaA = writeJson('array.schema.json', SCHEMA_NON_EMPTY_ARRAY);

    const result = await validateArtifacts(
      [
        makeArtifact({ relPath: 'a.json', schemaAbsPath: schemaN }),
        makeArtifact({ relPath: 'b.json', schemaAbsPath: schemaA }),
      ],
      tmpDir,
    );
    expect(result.kind).toBe('validators_ok');
  });
});

// ---------------------------------------------------------------------------
// AC-4 / RC-3: missing required artifact → validator_fail (not ENOENT throw)
// ---------------------------------------------------------------------------

describe('AC-4: missing required artifact', () => {
  it('returns validator_fail when required artifact does not exist', async () => {
    const result = await validateArtifacts(
      [makeArtifact({ relPath: 'missing.json' })],
      tmpDir,
    );

    expect(result.kind).toBe('validator_fail');
    if (result.kind !== 'validator_fail') return;

    expect(result.failures).toHaveLength(1);
    const f = result.failures[0];
    expect(f.artifactPath).toBe('missing.json');
    expect(f.errors).toHaveLength(1);
    expect(f.errors[0].keyword).toBe('required');
    expect(f.errors[0].message).toContain('missing.json');
  });

  it('skips (does not fail) a non-required absent artifact', async () => {
    const result = await validateArtifacts(
      [makeArtifact({ relPath: 'missing.json', required: false })],
      tmpDir,
    );
    expect(result.kind).toBe('validators_ok');
  });

  it('suppresses validators_ok when one required artifact is missing', async () => {
    writeJson('present.json', { name: 'ok' });
    const schemaPath = writeJson('schema.json', SCHEMA_NAME_REQUIRED);

    const result = await validateArtifacts(
      [
        makeArtifact({ relPath: 'present.json', schemaAbsPath: schemaPath }),
        makeArtifact({ relPath: 'absent.json' }),
      ],
      tmpDir,
    );
    // AC-3: a single failure suppresses validators_ok
    expect(result.kind).toBe('validator_fail');
  });
});

// ---------------------------------------------------------------------------
// AC-1 / AC-2: schema violation → structured validator_fail payload
// ---------------------------------------------------------------------------

describe('AC-1 / AC-2: schema violation payload', () => {
  it('returns validator_fail when artifact violates schema', async () => {
    // Missing required field 'name'
    writeJson('output.json', { age: 42 });
    const schemaPath = writeJson('schema.json', SCHEMA_NAME_REQUIRED);

    const result = await validateArtifacts(
      [makeArtifact({ relPath: 'output.json', schemaAbsPath: schemaPath })],
      tmpDir,
    );

    expect(result.kind).toBe('validator_fail');
    if (result.kind !== 'validator_fail') return;

    expect(result.failures).toHaveLength(1);
    const f = result.failures[0];
    expect(f.artifactPath).toBe('output.json');
    // schemaId comes from $id in the schema document
    expect(f.schemaId).toBe('https://example.com/schemas/name-required');
    // Raw error array (not toString'd) — RC-1
    expect(Array.isArray(f.errors)).toBe(true);
    expect(f.errors.length).toBeGreaterThan(0);
    // At least one error has instancePath + schemaPath (AC-6)
    const hasPath = f.errors.some(
      (e) => typeof e.instancePath === 'string' && typeof e.schemaPath === 'string',
    );
    expect(hasPath).toBe(true);
  });

  it('includes the offending value in verbose AJV errors (AC-6)', async () => {
    // 'name' is present but wrong type — AJV verbose includes data
    writeJson('output.json', { name: 123 });
    const schemaPath = writeJson('schema.json', SCHEMA_NAME_REQUIRED);

    const result = await validateArtifacts(
      [makeArtifact({ relPath: 'output.json', schemaAbsPath: schemaPath })],
      tmpDir,
    );

    expect(result.kind).toBe('validator_fail');
    if (result.kind !== 'validator_fail') return;

    const errors = result.failures[0].errors;
    // verbose mode populates `data` with the offending value
    const hasData = errors.some((e) => 'data' in e);
    expect(hasData).toBe(true);
  });

  it('error objects are structured (not strings) — RC-1', async () => {
    writeJson('output.json', { wrongField: true });
    const schemaPath = writeJson('schema.json', SCHEMA_NAME_REQUIRED);

    const result = await validateArtifacts(
      [makeArtifact({ relPath: 'output.json', schemaAbsPath: schemaPath })],
      tmpDir,
    );

    expect(result.kind).toBe('validator_fail');
    if (result.kind !== 'validator_fail') return;

    result.failures[0].errors.forEach((e) => {
      expect(typeof e).toBe('object');
      expect(typeof e.keyword).toBe('string');
      expect(typeof e.schemaPath).toBe('string');
    });
  });

  it('uses schema file path as schemaId when $id absent', async () => {
    const schemaNoId = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    };
    writeJson('output.json', {});
    const schemaPath = writeJson('schema-no-id.json', schemaNoId);

    const result = await validateArtifacts(
      [makeArtifact({ relPath: 'output.json', schemaAbsPath: schemaPath })],
      tmpDir,
    );

    expect(result.kind).toBe('validator_fail');
    if (result.kind !== 'validator_fail') return;

    // schemaId falls back to the schema file path
    expect(result.failures[0].schemaId).toBe(schemaPath);
  });
});

// ---------------------------------------------------------------------------
// AC-5: independent per-artifact validation (no short-circuit)
// ---------------------------------------------------------------------------

describe('AC-5: independent per-artifact validation', () => {
  it('validates all artifacts even when the first fails', async () => {
    // First artifact: invalid (missing required field)
    writeJson('a.json', {});
    const schemaN = writeJson('name.schema.json', SCHEMA_NAME_REQUIRED);

    // Second artifact: invalid (wrong type)
    writeJson('b.json', 'not-an-array');
    const schemaA = writeJson('array.schema.json', SCHEMA_NON_EMPTY_ARRAY);

    const result = await validateArtifacts(
      [
        makeArtifact({ relPath: 'a.json', schemaAbsPath: schemaN }),
        makeArtifact({ relPath: 'b.json', schemaAbsPath: schemaA }),
      ],
      tmpDir,
    );

    expect(result.kind).toBe('validator_fail');
    if (result.kind !== 'validator_fail') return;

    // Both failures collected, not just the first
    expect(result.failures).toHaveLength(2);
    const paths = result.failures.map((f) => f.artifactPath);
    expect(paths).toContain('a.json');
    expect(paths).toContain('b.json');
  });

  it('collects missing-file + schema-violation independently', async () => {
    // First artifact: missing
    // Second artifact: present but schema violation
    writeJson('b.json', { wrongField: true });
    const schemaPath = writeJson('schema.json', SCHEMA_NAME_REQUIRED);

    const result = await validateArtifacts(
      [
        makeArtifact({ relPath: 'missing.json' }),
        makeArtifact({ relPath: 'b.json', schemaAbsPath: schemaPath }),
      ],
      tmpDir,
    );

    expect(result.kind).toBe('validator_fail');
    if (result.kind !== 'validator_fail') return;
    expect(result.failures).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// RC-2: no schema caching — schema file changes are reflected immediately
// ---------------------------------------------------------------------------

describe('RC-2: no schema caching between validation calls', () => {
  it('picks up schema changes between calls', async () => {
    const schemaPath = writeJson('schema.json', SCHEMA_NAME_REQUIRED);
    writeJson('output.json', { name: 'ok' });

    // First call: schema requires 'name' → should pass
    const first = await validateArtifacts(
      [makeArtifact({ relPath: 'output.json', schemaAbsPath: schemaPath })],
      tmpDir,
    );
    expect(first.kind).toBe('validators_ok');

    // Overwrite schema to also require 'age' → same data now fails
    fs.writeFileSync(
      schemaPath,
      JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        required: ['name', 'age'],
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
      }),
    );

    const second = await validateArtifacts(
      [makeArtifact({ relPath: 'output.json', schemaAbsPath: schemaPath })],
      tmpDir,
    );
    // No caching: must see the updated schema
    expect(second.kind).toBe('validator_fail');
  });
});

// ---------------------------------------------------------------------------
// Edge cases: invalid JSON artifact, unreadable schema
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('returns validator_fail for an artifact that is not valid JSON', async () => {
    writeRaw('output.json', 'this is not JSON {{{{');
    const schemaPath = writeJson('schema.json', SCHEMA_NAME_REQUIRED);

    const result = await validateArtifacts(
      [makeArtifact({ relPath: 'output.json', schemaAbsPath: schemaPath })],
      tmpDir,
    );

    expect(result.kind).toBe('validator_fail');
    if (result.kind !== 'validator_fail') return;
    expect(result.failures[0].errors[0].message).toContain('not valid JSON');
  });

  it('returns validator_fail when schema file does not exist', async () => {
    writeJson('output.json', { name: 'ok' });

    const result = await validateArtifacts(
      [
        makeArtifact({
          relPath: 'output.json',
          schemaAbsPath: path.join(tmpDir, 'nonexistent.schema.json'),
        }),
      ],
      tmpDir,
    );

    expect(result.kind).toBe('validator_fail');
    if (result.kind !== 'validator_fail') return;
    expect(result.failures[0].errors[0].message).toContain('schema file unreadable');
  });

  it('does not throw for any input — always returns a typed result', async () => {
    // Even with an empty artifacts array and a non-existent worktree
    await expect(
      validateArtifacts([], '/definitely/does/not/exist'),
    ).resolves.toEqual({ kind: 'validators_ok' });
  });
});
