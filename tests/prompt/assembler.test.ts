/**
 * Unit tests for src/server/prompt/assembler.ts and src/server/prompt/engine.ts.
 *
 * All tests are pure: no SQLite, no filesystem, no subprocess.
 * Every PromptContext is a hand-rolled literal (prompt-template-spec.md §4).
 *
 * Coverage map (feat-prompt-asm acceptance + review criteria):
 *
 *   AC-1  {{item}} → opaque JSON blob; {{item_state}} → harness-state object.
 *   AC-2  Missing key → [MISSING:key]; no throw.
 *   AC-3  Assembler has no DB/FS access (structural — verified by import graph).
 *   AC-5  Dry-run: assemblePrompt with a pre-built context returns full string.
 *   AC-6  {{handoff}} → most-recent handoff entries serialized.
 *   RC-1  No I/O imports in assembler (structural).
 *   RC-2  Hand-rolled engine (no Mustache/Handlebars) — verified by import graph.
 *   RC-4  All tests pass without touching SQLite or the filesystem.
 */

import { describe, it, expect } from 'vitest';
import { assemblePrompt } from '../../src/server/prompt/assembler.js';
import { replaceTemplateVars } from '../../src/server/prompt/engine.js';
import type { PromptContext } from '../../src/server/prompt/engine.js';

// ---------------------------------------------------------------------------
// § 1  Simple string substitution
// ---------------------------------------------------------------------------

describe('assemblePrompt — simple string substitution', () => {
  it('replaces a single top-level string token', () => {
    const tmpl = 'Hello, {{workflow_name}}!';
    const ctx: PromptContext = { workflow_name: 'add-auth' };
    expect(assemblePrompt(tmpl, ctx)).toBe('Hello, add-auth!');
  });

  it('replaces multiple distinct tokens in order', () => {
    const tmpl = '{{stage_id}} / {{workflow_name}}';
    const ctx: PromptContext = { stage_id: 'implementation', workflow_name: 'my-wf' };
    expect(assemblePrompt(tmpl, ctx)).toBe('implementation / my-wf');
  });

  it('replaces the same token appearing twice', () => {
    const tmpl = '{{x}} and {{x}} again';
    const ctx: PromptContext = { x: 'foo' };
    expect(assemblePrompt(tmpl, ctx)).toBe('foo and foo again');
  });

  it('leaves non-token text untouched', () => {
    const tmpl = 'no tokens here';
    expect(assemblePrompt(tmpl, {})).toBe('no tokens here');
  });

  it('handles an empty template', () => {
    expect(assemblePrompt('', {})).toBe('');
  });

  it('handles a template with only a token', () => {
    const ctx: PromptContext = { msg: 'hi' };
    expect(assemblePrompt('{{msg}}', ctx)).toBe('hi');
  });

  it('passes options.templatePath through without error (informational only)', () => {
    const ctx: PromptContext = { x: 'v' };
    expect(() => assemblePrompt('{{x}}', ctx, { templatePath: '/some/path.md' })).not.toThrow();
    expect(assemblePrompt('{{x}}', ctx, { templatePath: '/some/path.md' })).toBe('v');
  });
});

// ---------------------------------------------------------------------------
// § 2  AC-1: {{item}} — opaque JSON blob serialization
// ---------------------------------------------------------------------------

describe('assemblePrompt — AC-1 {{item}} opaque blob', () => {
  it('{{item}} at top-level → pretty-printed JSON of the entire object', () => {
    const item = {
      id: 'feat-001',
      description: 'User can log in',
      acceptance_criteria: ['accepts email', 'returns JWT'],
      depends_on: [] as string[],
    };
    const ctx: PromptContext = { item };
    const result = assemblePrompt('{{item}}', ctx);
    expect(result).toBe(JSON.stringify(item, null, 2));
  });

  it('{{item.description}} → leaf string value without surrounding JSON', () => {
    const ctx: PromptContext = {
      item: { description: 'User can log in', priority: 1 },
    };
    expect(assemblePrompt('{{item.description}}', ctx)).toBe('User can log in');
  });

  it('{{item.acceptance_criteria}} → JSON-serialized array (leaf is array)', () => {
    const criteria = ['- accepts email', '- returns JWT'];
    const ctx: PromptContext = {
      item: { description: 'Login', acceptance_criteria: criteria },
    };
    const result = assemblePrompt('{{item.acceptance_criteria}}', ctx);
    expect(result).toBe(JSON.stringify(criteria, null, 2));
  });

  it('{{item.nested.deep}} → resolves two levels of dot traversal', () => {
    const ctx: PromptContext = {
      item: { nested: { deep: 'value-here' } },
    };
    expect(assemblePrompt('{{item.nested.deep}}', ctx)).toBe('value-here');
  });

  it('{{item}} with numeric fields → serialized as JSON', () => {
    const ctx: PromptContext = {
      item: { priority: 5, active: true },
    };
    const result = assemblePrompt('{{item}}', ctx);
    expect(result).toBe(JSON.stringify({ priority: 5, active: true }, null, 2));
  });
});

// ---------------------------------------------------------------------------
// § 3  AC-1: {{item_state}} — harness state fields
// ---------------------------------------------------------------------------

describe('assemblePrompt — AC-1 {{item_state}} harness state', () => {
  const itemState = {
    status: 'in_progress',
    current_phase: 'implement',
    retry_count: 0,
    blocked_reason: null,
  };

  it('{{item_state}} → pretty-printed JSON of harness state object', () => {
    const ctx: PromptContext = { item_state: itemState as unknown as Record<string, unknown> };
    const result = assemblePrompt('{{item_state}}', ctx);
    expect(result).toBe(JSON.stringify(itemState, null, 2));
  });

  it('{{item_state.status}} → the status string', () => {
    const ctx: PromptContext = { item_state: itemState as unknown as Record<string, unknown> };
    expect(assemblePrompt('{{item_state.status}}', ctx)).toBe('in_progress');
  });

  it('{{item_state.current_phase}} → the phase string', () => {
    const ctx: PromptContext = { item_state: itemState as unknown as Record<string, unknown> };
    expect(assemblePrompt('{{item_state.current_phase}}', ctx)).toBe('implement');
  });

  it('{{item_state.retry_count}} → numeric → JSON-serialized', () => {
    const ctx: PromptContext = { item_state: itemState as unknown as Record<string, unknown> };
    expect(assemblePrompt('{{item_state.retry_count}}', ctx)).toBe('0');
  });

  it('{{item_state.blocked_reason}} when null → [MISSING:item_state.blocked_reason]', () => {
    const ctx: PromptContext = { item_state: itemState as unknown as Record<string, unknown> };
    // null leaf → [MISSING:...] per AC-2
    expect(assemblePrompt('{{item_state.blocked_reason}}', ctx)).toBe(
      '[MISSING:item_state.blocked_reason]',
    );
  });
});

// ---------------------------------------------------------------------------
// § 4  AC-2: Missing key → [MISSING:key], no throw
// ---------------------------------------------------------------------------

describe('assemblePrompt — AC-2 missing key produces [MISSING:key]', () => {
  it('top-level missing key → [MISSING:key]', () => {
    const result = assemblePrompt('{{unknown_var}}', {});
    expect(result).toBe('[MISSING:unknown_var]');
  });

  it('missing key does not throw', () => {
    expect(() => assemblePrompt('{{totally_absent}}', {})).not.toThrow();
  });

  it('missing nested key → [MISSING:full.path]', () => {
    const ctx: PromptContext = { item: { description: 'ok' } };
    expect(assemblePrompt('{{item.nonexistent}}', ctx)).toBe('[MISSING:item.nonexistent]');
  });

  it('top-level key exists but intermediate object is missing → [MISSING:full.path]', () => {
    const ctx: PromptContext = { item: { shallow: 'val' } };
    expect(assemblePrompt('{{item.deep.gone}}', ctx)).toBe('[MISSING:item.deep.gone]');
  });

  it('mix of present and missing keys in same template', () => {
    const ctx: PromptContext = { present: 'yes' };
    const result = assemblePrompt('{{present}} {{absent}}', ctx);
    expect(result).toBe('yes [MISSING:absent]');
  });

  it('[MISSING:key] output is a literal string, not a thrown error', () => {
    const ctx: PromptContext = {};
    const result = assemblePrompt('pre {{x}} post', ctx);
    expect(result).toBe('pre [MISSING:x] post');
  });

  it('multiple consecutive missing keys each get their own [MISSING:...]', () => {
    const result = assemblePrompt('{{a}} {{b}} {{c}}', {});
    expect(result).toBe('[MISSING:a] [MISSING:b] [MISSING:c]');
  });

  it('missing key whose name contains underscores', () => {
    expect(assemblePrompt('{{git_log_recent}}', {})).toBe('[MISSING:git_log_recent]');
  });
});

// ---------------------------------------------------------------------------
// § 5  AC-5: Dry-run preview path (assembler without spawning)
// ---------------------------------------------------------------------------

describe('assemblePrompt — AC-5 dry-run preview', () => {
  it('full context → fully-assembled prompt string (no spawning required)', () => {
    const item = { id: 'feat-001', description: 'Login feature', depends_on: [] as string[] };
    const itemState = { status: 'in_progress', current_phase: 'implement', retry_count: 0 };
    const ctx: PromptContext = {
      workflow_name: 'add-auth',
      stage_id: 'implementation',
      item_id: 'feat-001',
      item,
      item_state: itemState,
      architecture_md: '# Architecture',
      handoff: '[]',
      git_log_recent: 'abc123 initial\n',
      recent_diff: '',
      user_injected_context: '',
    };

    const template = `You are implementing {{item_id}} for {{workflow_name}}.
## Item
{{item.description}}
## State
Phase: {{item_state.current_phase}}
## Architecture
{{architecture_md}}
## Git log
{{git_log_recent}}`;

    const result = assemblePrompt(template, ctx);
    expect(result).toContain('You are implementing feat-001 for add-auth.');
    expect(result).toContain('Login feature');
    expect(result).toContain('Phase: implement');
    expect(result).toContain('# Architecture');
    expect(result).toContain('abc123 initial');
  });
});

// ---------------------------------------------------------------------------
// § 6  AC-6: {{handoff}} — handoff entries serialized
// ---------------------------------------------------------------------------

describe('assemblePrompt — AC-6 {{handoff}} handoff entries', () => {
  it('{{handoff}} with serialized entries string → spliced verbatim', () => {
    const entries = [
      { phase: 'implement', attempt: 0, ts: '2026-04-13T00:00:00Z', deferred: [] as string[] },
    ];
    const ctx: PromptContext = { handoff: JSON.stringify(entries, null, 2) };
    const result = assemblePrompt('{{handoff}}', ctx);
    expect(result).toBe(JSON.stringify(entries, null, 2));
  });

  it('{{handoff}} missing → [MISSING:handoff]', () => {
    expect(assemblePrompt('{{handoff}}', {})).toBe('[MISSING:handoff]');
  });

  it('{{handoff}} empty string → empty string (builder provides explicit empty)', () => {
    const ctx: PromptContext = { handoff: '' };
    expect(assemblePrompt('{{handoff}}', ctx)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// § 7  Engine edge cases (replaceTemplateVars directly)
// ---------------------------------------------------------------------------

describe('replaceTemplateVars — engine edge cases', () => {
  it('whitespace inside braces is NOT matched — passes through unchanged', () => {
    // "{{ foo }}" has whitespace inside; TOKEN_RE does not match it.
    expect(replaceTemplateVars('{{ foo }}', { foo: 'bar' })).toBe('{{ foo }}');
  });

  it('{{ with no closing }} passes through unchanged', () => {
    expect(replaceTemplateVars('incomplete {{', {})).toBe('incomplete {{');
  });

  it('deeply nested dot path resolves correctly', () => {
    const ctx: PromptContext = {
      item: { a: { b: { c: 'deep-val' } } },
    };
    expect(replaceTemplateVars('{{item.a.b.c}}', ctx)).toBe('deep-val');
  });

  it('intermediate array in dot path → [MISSING:...]', () => {
    // item.list is an array; cannot traverse into an array via dot at intermediate step
    const ctx: PromptContext = {
      item: { list: [1, 2, 3] },
    };
    expect(replaceTemplateVars('{{item.list.something}}', ctx)).toBe(
      '[MISSING:item.list.something]',
    );
  });

  it('top-level key whose value is an array → JSON-serialized', () => {
    const ctx = { items: [{ id: 1 }, { id: 2 }] } as unknown as PromptContext;
    const result = replaceTemplateVars('{{items}}', ctx);
    expect(result).toBe(JSON.stringify([{ id: 1 }, { id: 2 }], null, 2));
  });

  it('boolean leaf at top level → JSON-serialized (not "true"/"false" from toString)', () => {
    const ctx = { flag: true } as unknown as PromptContext;
    // Boolean is not a string, so JSON.stringify is used → "true"
    expect(replaceTemplateVars('{{flag}}', ctx)).toBe('true');
  });

  it('numeric leaf → JSON-serialized string', () => {
    const ctx = { count: 42 } as unknown as PromptContext;
    expect(replaceTemplateVars('{{count}}', ctx)).toBe('42');
  });

  it('empty string value → empty string in output (not [MISSING:...])', () => {
    const ctx: PromptContext = { user_injected_context: '' };
    expect(replaceTemplateVars('pre {{user_injected_context}} post', ctx)).toBe('pre  post');
  });

  it('token with only underscores and numbers → matched', () => {
    const ctx: PromptContext = { var_123: 'ok' };
    expect(replaceTemplateVars('{{var_123}}', ctx)).toBe('ok');
  });

  it('token starting with uppercase → matched', () => {
    const ctx: PromptContext = { MyVar: 'x' };
    expect(replaceTemplateVars('{{MyVar}}', ctx)).toBe('x');
  });

  it('multiline template → all tokens replaced', () => {
    const ctx: PromptContext = { a: 'A', b: 'B' };
    const tmpl = `line1 {{a}}\nline2 {{b}}\nline3`;
    expect(replaceTemplateVars(tmpl, ctx)).toBe('line1 A\nline2 B\nline3');
  });

  it('token at start and end of string', () => {
    const ctx: PromptContext = { start: 'S', end: 'E' };
    expect(replaceTemplateVars('{{start}} middle {{end}}', ctx)).toBe('S middle E');
  });

  it('context key with dot in name is NOT treated as nested — not possible in PromptContext', () => {
    // PromptContext has flat top-level keys; dot traversal is for nested objects.
    // This verifies that {{a.b}} does NOT match the top-level key "a.b".
    const ctx = { 'a.b': 'flat' } as unknown as PromptContext;
    // {{a.b}} tries ctx["a"]["b"], not ctx["a.b"], so it's [MISSING:a.b]
    expect(replaceTemplateVars('{{a.b}}', ctx)).toBe('[MISSING:a.b]');
  });
});

// ---------------------------------------------------------------------------
// § 8  Full prompt assembly (end-to-end, no I/O)
// ---------------------------------------------------------------------------

describe('assemblePrompt — end-to-end full prompt example', () => {
  it('reproduces the spec example from prompt-template-spec.md §9', () => {
    const item = {
      id: 'feat-001',
      description: 'User can log in with email and password',
      acceptance_criteria: ['- accepts email/password', '- returns JWT'],
      review_criteria: ['- no plaintext passwords', '- rate limiting'],
      depends_on: [] as string[],
      category: 'auth',
    };
    const itemState = {
      status: 'in_progress',
      current_phase: 'implement',
      retry_count: 0,
      blocked_reason: null,
    };

    const ctx: PromptContext = {
      item_id: 'feat-001',
      item,
      item_state: itemState as unknown as Record<string, unknown>,
      workflow_name: 'add-auth',
      stage_id: 'implementation',
      architecture_md: '# Architecture\n\n...',
      handoff: '[\n  {\n    "phase": "implement"\n  }\n]',
      git_log_recent: 'abcd123 scaffold\n1234567 schema\n',
      recent_diff: 'diff --git a/src/auth/login.ts ...',
      user_injected_context: '',
    };

    const template = `You are implementing {{item_id}} for workflow {{workflow_name}}.

## Feature spec
{{item.description}}

## Acceptance criteria
{{item.acceptance_criteria}}

## Current status
Phase: {{item_state.current_phase}}, attempt: {{item_state.retry_count}}

## Architecture
{{architecture_md}}

## Handoff entries for this item
{{handoff}}

## Recent commits
{{git_log_recent}}

## Current diff vs last completed phase
{{recent_diff}}

## User-injected guidance
{{user_injected_context}}`;

    const result = assemblePrompt(template, ctx);

    expect(result).toContain('You are implementing feat-001 for workflow add-auth.');
    expect(result).toContain('User can log in with email and password');
    expect(result).toContain(JSON.stringify(item.acceptance_criteria, null, 2));
    expect(result).toContain('Phase: implement, attempt: 0');
    expect(result).toContain('# Architecture');
    expect(result).toContain('"phase": "implement"');
    expect(result).toContain('abcd123 scaffold');
    expect(result).toContain('diff --git');
    // user_injected_context is empty string → no [MISSING:...], just empty
    expect(result).not.toContain('[MISSING:');
  });
});
