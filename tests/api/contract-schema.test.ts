/**
 * Asserts that docs/design/schemas/api-responses.schema.json stays in sync
 * with the TypeScript types in src/shared/types/.
 *
 * These tests catch the most common drift pattern: renaming a TypeScript field
 * (e.g. createdAt → created_at) without updating the schema, or vice versa.
 *
 * The tests do NOT import ts-json-schema-generator — instead they:
 *   1. Import the runtime type values (WORKFLOW_STATUS_VALUES) and compare
 *      them to the schema's enum.
 *   2. Compile the schema with Ajv and run typed sample data through it to
 *      verify the schema accepts what TypeScript says is valid.
 *   3. Verify the schema rejects snake_case field names (the RC-1 drift pattern).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { WORKFLOW_STATUS_VALUES } from '../../src/shared/types/workflow.js';
import type { WorkflowRow } from '../../src/shared/types/workflow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '../../docs/design/schemas/api-responses.schema.json');
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown> & {
  $id: string;
  $defs: Record<string, { required?: string[]; properties?: Record<string, unknown>; enum?: string[]; items?: unknown }>;
};

function makeAjv() {
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  ajv.addSchema(schema);
  return ajv;
}

// ---------------------------------------------------------------------------
// WorkflowStatus
// ---------------------------------------------------------------------------

describe('WorkflowStatus $def', () => {
  it('enum matches WORKFLOW_STATUS_VALUES (single source of truth)', () => {
    const schemaEnum = schema.$defs.WorkflowStatus?.enum ?? [];
    expect(new Set(schemaEnum)).toEqual(new Set(WORKFLOW_STATUS_VALUES));
  });
});

// ---------------------------------------------------------------------------
// WorkflowRow
// ---------------------------------------------------------------------------

describe('WorkflowRow $def', () => {
  const ajv = makeAjv();
  const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/WorkflowRow` });

  it('requires camelCase fields (not snake_case)', () => {
    const required = schema.$defs.WorkflowRow?.required ?? [];
    expect(required).toContain('currentStage');
    expect(required).toContain('createdAt');
    expect(required).toContain('updatedAt');
    expect(required).toContain('activeSessions');
    expect(required).toContain('unreadEvents');
    expect(required).not.toContain('current_stage');
    expect(required).not.toContain('created_at');
    expect(required).not.toContain('updated_at');
    expect(required).not.toContain('active_sessions');
  });

  it('accepts a valid WorkflowRow', () => {
    const valid: WorkflowRow = {
      id: 'wf-1',
      name: 'test',
      status: 'pending',
      currentStage: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      activeSessions: 0,
      unreadEvents: 0,
    };
    expect(validate(valid), JSON.stringify(validate.errors)).toBe(true);
  });

  it('accepts WorkflowRow with non-null currentStage', () => {
    const valid: WorkflowRow = {
      id: 'wf-2',
      name: 'test',
      status: 'in_progress',
      currentStage: 'stage-1',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      activeSessions: 1,
      unreadEvents: 3,
    };
    expect(validate(valid)).toBe(true);
  });

  it('rejects snake_case field names (RC-1 drift pattern)', () => {
    const invalid = {
      id: 'wf-3',
      name: 'test',
      status: 'pending',
      current_stage: null,    // snake_case drift
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      active_sessions: 0,
      unread_events: 0,
    };
    expect(validate(invalid)).toBe(false);
  });

  it('rejects an unknown WorkflowStatus value', () => {
    const invalid = {
      id: 'wf-4',
      name: 'test',
      status: 'not_a_real_status',
      currentStage: null,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      activeSessions: 0,
      unreadEvents: 0,
    };
    expect(validate(invalid)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WorkflowsListResponse
// ---------------------------------------------------------------------------

describe('WorkflowsListResponse $def', () => {
  const ajv = makeAjv();
  const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/WorkflowsListResponse` });

  it('requires workflows, hasMore, nextBefore', () => {
    const required = schema.$defs.WorkflowsListResponse?.required ?? [];
    expect(required).toContain('workflows');
    expect(required).toContain('hasMore');
    expect(required).toContain('nextBefore');
  });

  it('accepts empty list response', () => {
    expect(validate({ workflows: [], hasMore: false, nextBefore: null })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ItemSession
// ---------------------------------------------------------------------------

describe('ItemSession $def', () => {
  it('requires camelCase fields (not snake_case)', () => {
    const required = schema.$defs.ItemSession?.required ?? [];
    expect(required).toContain('startedAt');
    expect(required).toContain('endedAt');
    expect(required).toContain('exitCode');
    expect(required).not.toContain('started_at');
    expect(required).not.toContain('ended_at');
    expect(required).not.toContain('exit_code');
  });
});

// ---------------------------------------------------------------------------
// TimelineResponse
// ---------------------------------------------------------------------------

describe('TimelineResponse $def', () => {
  const ajv = makeAjv();
  const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/TimelineResponse` });

  it('requires camelCase workflowId (not workflow_id)', () => {
    const required = schema.$defs.TimelineResponse?.required ?? [];
    expect(required).toContain('workflowId');
    expect(required).not.toContain('workflow_id');
  });

  it('accepts empty events list', () => {
    expect(validate({ workflowId: 'wf-1', events: [] })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UsageResponse
// ---------------------------------------------------------------------------

describe('UsageResponse $def', () => {
  const ajv = makeAjv();
  const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/UsageResponse` });

  it('UsageRow requires camelCase token fields', () => {
    const required = schema.$defs.UsageRow?.required ?? [];
    expect(required).toContain('inputTokens');
    expect(required).toContain('outputTokens');
    expect(required).toContain('cacheCreationInputTokens');
    expect(required).toContain('cacheReadInputTokens');
    expect(required).toContain('sessionCount');
    expect(required).not.toContain('input_tokens');
    expect(required).not.toContain('output_tokens');
    expect(required).not.toContain('session_count');
  });

  it('accepts empty rows response', () => {
    expect(validate({ workflowId: 'wf-1', groupBy: 'session', rows: [] })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SessionLogResponse
// ---------------------------------------------------------------------------

describe('SessionLogResponse $def', () => {
  const ajv = makeAjv();
  const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/SessionLogResponse` });

  it('entries are strings (raw JSONL lines, not objects)', () => {
    const entriesSchema = (schema.$defs.SessionLogResponse?.properties?.['entries'] as { items?: { type?: string } } | undefined)?.items;
    expect((entriesSchema as { type?: string })?.type).toBe('string');
  });

  it('accepts empty log response', () => {
    expect(validate({ entries: [], nextSeq: 0, hasMore: false })).toBe(true);
  });

  it('accepts log response with string entries', () => {
    expect(validate({
      entries: ['{"seq":1,"ts":"2024-01-01","type":"text"}'],
      nextSeq: 1,
      hasMore: false,
    })).toBe(true);
  });

  it('rejects log response with object entries', () => {
    expect(validate({
      entries: [{ seq: 1, ts: '2024-01-01', type: 'text' }],
      nextSeq: 1,
      hasMore: false,
    })).toBe(false);
  });
});
