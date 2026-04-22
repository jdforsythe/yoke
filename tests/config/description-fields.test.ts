/**
 * Unit coverage for the optional `description` field on Stage and Phase.
 *
 * Added in F2 of the nomenclature follow-ups. These tests guarantee that:
 *   - A config with stage- and phase-level `description` round-trips through
 *     the loader into ResolvedConfig unchanged.
 *   - A config without any `description` parses cleanly and leaves the field
 *     `undefined` on both Stage and Phase (not serialised as a spurious null
 *     or empty string).
 *
 * The loader/schema machinery is covered elsewhere — this file intentionally
 * asserts just the new field's pass-through behaviour.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadTemplate } from '../../src/server/config/loader.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-description-fields-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTemplate(content: string, name = 'default'): void {
  const dir = path.join(tmpDir, '.yoke', 'templates');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.yml`), content, 'utf8');
}

describe('Stage.description / Phase.description — pass-through', () => {
  it('preserves stage.description and phase.description when set', () => {
    const yaml = `\
version: "1"
template:
  name: desc-test
pipeline:
  stages:
    - id: main
      description: The main build stage — exercises the implement phase.
      run: once
      phases:
        - implement
phases:
  implement:
    description: Apply the user's spec to the codebase.
    command: claude
    args: []
    prompt_template: prompts/implement.md
`;
    writeTemplate(yaml);
    const cfg = loadTemplate(tmpDir, 'default');

    expect(cfg.pipeline.stages[0].description).toBe(
      "The main build stage — exercises the implement phase.",
    );
    expect(cfg.phases['implement'].description).toBe(
      "Apply the user's spec to the codebase.",
    );
  });

  it('leaves description undefined on both Stage and Phase when omitted', () => {
    const yaml = `\
version: "1"
template:
  name: no-desc
pipeline:
  stages:
    - id: main
      run: once
      phases:
        - implement
phases:
  implement:
    command: claude
    args: []
    prompt_template: prompts/implement.md
`;
    writeTemplate(yaml);
    const cfg = loadTemplate(tmpDir, 'default');

    expect(cfg.pipeline.stages[0].description).toBeUndefined();
    expect(cfg.phases['implement'].description).toBeUndefined();

    // Explicit property-presence check — the key should not exist at all
    // rather than being present-with-undefined. JSON.stringify round-trip
    // is the cheapest way to assert that.
    const roundTripped = JSON.parse(JSON.stringify(cfg)) as typeof cfg;
    expect('description' in roundTripped.pipeline.stages[0]).toBe(false);
    expect('description' in roundTripped.phases['implement']).toBe(false);
  });
});
