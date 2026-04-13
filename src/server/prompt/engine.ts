/**
 * Hand-rolled {{name}} template engine.
 *
 * Responsibilities:
 *   - Scan a template string for {{variable}} and {{variable.path}} tokens.
 *   - Resolve each token against a PromptContext (plain object).
 *   - Splice the resolved value into the output string.
 *
 * Non-responsibilities:
 *   - No file I/O (context.ts owns file reads).
 *   - No database access.
 *   - No shell execution.
 *   - No Mustache/Handlebars dependency — this is hand-rolled per spec.
 *
 * Syntax (plan-draft3 §Configuration → Prompt template engine, D11):
 *   {{variable_name}}             top-level key lookup
 *   {{variable_name.field}}       dot-traversal into an object value
 *
 * Missing key behavior (feat-prompt-asm AC-2):
 *   A template token whose path cannot be resolved produces [MISSING:path]
 *   in the output. The engine does NOT throw on a missing key.
 *
 * Serialization (prompt-template-spec.md §3.5):
 *   - Top-level or leaf string value  → inserted as-is.
 *   - Object/array value (any depth)  → JSON.stringify(value, null, 2).
 *   - null or undefined at any step   → [MISSING:path].
 */

// ---------------------------------------------------------------------------
// PromptContext — shared type for engine, assembler, and context builder
// ---------------------------------------------------------------------------

/**
 * A flat map of variable names to string or object values.
 *
 * String values are spliced in directly.
 * Object values support dot-traversal in templates (e.g. {{item.description}})
 * and are serialized as pretty-printed JSON when referenced at the top level.
 *
 * null / undefined values are treated as missing and produce [MISSING:key].
 */
export interface PromptContext {
  [key: string]: string | Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Token pattern
// ---------------------------------------------------------------------------

/**
 * Matches {{variable}} and {{variable.path.subpath}} tokens.
 *
 * Capture group 1: the full dotted identifier.
 *
 * Identifier chars: [A-Za-z_] then [A-Za-z0-9_.]*
 * This rejects whitespace inside braces ({{ foo }} is not matched).
 * Non-matching {{ ... }} text passes through unchanged.
 */
const TOKEN_RE = /\{\{([A-Za-z_][A-Za-z0-9_.]*)\}\}/g;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a dotted path against the context object and returns a string.
 *
 * Resolution rules:
 *   1. Split path on '.'.
 *   2. Look up the first segment in ctx.
 *   3. Walk subsequent segments through the resulting object.
 *   4. Any missing key, non-object intermediate, or null/undefined leaf
 *      returns `[MISSING:<path>]` — never throws.
 *   5. A string leaf is returned as-is.
 *   6. An object/array leaf is serialized as JSON.stringify(v, null, 2).
 */
function resolvePath(ctx: PromptContext, path: string): string {
  const parts = path.split('.');
  const topKey = parts[0];

  if (!(topKey in ctx)) {
    return `[MISSING:${path}]`;
  }

  let value: unknown = ctx[topKey];

  for (let i = 1; i < parts.length; i++) {
    if (value === null || value === undefined) {
      return `[MISSING:${path}]`;
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      // Cannot traverse into a primitive or array at an intermediate step.
      return `[MISSING:${path}]`;
    }
    const obj = value as Record<string, unknown>;
    if (!(parts[i] in obj)) {
      return `[MISSING:${path}]`;
    }
    value = obj[parts[i]];
  }

  if (value === null || value === undefined) {
    return `[MISSING:${path}]`;
  }

  if (typeof value === 'string') {
    return value;
  }

  // Objects and arrays → stable pretty-printed JSON.
  return JSON.stringify(value, null, 2);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Replaces all {{token}} references in `template` using `ctx`.
 *
 * - Single-pass left-to-right scan.
 * - Missing keys produce [MISSING:key] (never throws).
 * - Unrecognised {{ ... }} patterns (whitespace, unsupported chars) pass
 *   through unchanged because TOKEN_RE does not match them.
 *
 * Pure function: no I/O, no side effects.
 */
export function replaceTemplateVars(template: string, ctx: PromptContext): string {
  // String.prototype.replace with a /g regex resets lastIndex before starting,
  // so using a module-level TOKEN_RE is safe across multiple calls.
  return template.replace(TOKEN_RE, (_match, path: string) => resolvePath(ctx, path));
}
