import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../../src/server/config/loader.js';
import { ConfigLoadError } from '../../src/server/config/errors.js';

// ---------------------------------------------------------------------------
// Temp-dir fixture helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-loader-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeYaml(content: string, filename = '.yoke.yml'): string {
  const filePath = path.join(tmpDir, filename);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

// ---------------------------------------------------------------------------
// Minimal valid .yoke.yml used as the happy-path baseline
// ---------------------------------------------------------------------------

const MINIMAL_VALID = `\
version: "1"
project:
  name: test-project
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

// ---------------------------------------------------------------------------
// Acceptance criterion 1 — valid config parses to ResolvedConfig
// ---------------------------------------------------------------------------

describe('loadConfig — valid configs', () => {
  it('parses a minimal valid .yoke.yml without throwing', () => {
    const fp = writeYaml(MINIMAL_VALID);
    const cfg = loadConfig(fp);
    expect(cfg.version).toBe('1');
    expect(cfg.project.name).toBe('test-project');
    expect(cfg.pipeline.stages[0].id).toBe('main');
  });

  it('parses a config with all major optional sections without throwing', () => {
    const yaml = `\
version: "1"
project:
  name: full-test
pipeline:
  stages:
    - id: main
      run: once
      phases:
        - plan
phases:
  plan:
    command: claude
    args: ["--print"]
    prompt_template: prompts/plan.md
    output_artifacts:
      - path: features.json
        schema: schemas/features.schema.json
        required: true
    max_outer_retries: 2
    retry_ladder: [continue, fresh_with_failure_summary]
    heartbeat:
      activity_timeout_s: 90
    pre: []
    post:
      - name: check
        run: ["./scripts/check.sh"]
        actions:
          "0": continue
          "*": stop-and-ask
worktrees:
  base_dir: .worktrees
  branch_prefix: "yoke/"
  auto_cleanup: true
  bootstrap:
    commands: ["pnpm install"]
  teardown:
    script: .yoke/teardown.sh
notifications:
  enabled: true
github:
  enabled: false
retention:
  sqlite: forever
logging:
  retain_stream_json: true
runtime:
  keep_awake: false
rate_limit:
  handling: passive
ui:
  port: 3456
  bind: "127.0.0.1"
  auth: false
safety_mode: default
`;
    const fp = writeYaml(yaml);
    expect(() => loadConfig(fp)).not.toThrow();
    const cfg = loadConfig(fp);
    expect(cfg.worktrees?.base_dir).toBe('.worktrees');
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 2 — unknown top-level key rejected, key named
// ---------------------------------------------------------------------------

describe('loadConfig — unknown keys', () => {
  it('rejects an unknown top-level key with a validation_error naming it', () => {
    const fp = writeYaml(MINIMAL_VALID + 'totally_unknown_key: value\n');
    let err: ConfigLoadError | undefined;
    try {
      loadConfig(fp);
    } catch (e) {
      err = e as ConfigLoadError;
    }
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(err!.detail.kind).toBe('validation_error');
    expect(err!.detail.message).toMatch(/totally_unknown_key/);
  });

  it('rejects an unknown key inside a phase (additionalProperties:false at nested level)', () => {
    const yaml =
      MINIMAL_VALID.replace(
        '    prompt_template: prompts/implement.md',
        '    prompt_template: prompts/implement.md\n    bad_phase_key: oops',
      );
    let err: ConfigLoadError | undefined;
    try {
      loadConfig(writeYaml(yaml));
    } catch (e) {
      err = e as ConfigLoadError;
    }
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(err!.detail.kind).toBe('validation_error');
    // Must name the offending property
    expect(err!.detail.message).toMatch(/bad_phase_key/);
  });

  it('rejects an unknown key inside a pipeline stage', () => {
    const yaml = `\
version: "1"
project:
  name: test
pipeline:
  stages:
    - id: main
      run: once
      phases: [implement]
      ghost_field: oops
phases:
  implement:
    command: claude
    args: []
    prompt_template: p.md
`;
    let err: ConfigLoadError | undefined;
    try {
      loadConfig(writeYaml(yaml));
    } catch (e) {
      err = e as ConfigLoadError;
    }
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(err!.detail.kind).toBe('validation_error');
    expect(err!.detail.message).toMatch(/ghost_field/);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 3 — missing / wrong version rejected with clear message
// ---------------------------------------------------------------------------

describe('loadConfig — version pin', () => {
  it('rejects a config missing the version field', () => {
    const yaml = MINIMAL_VALID.replace('version: "1"\n', '');
    let err: ConfigLoadError | undefined;
    try {
      loadConfig(writeYaml(yaml));
    } catch (e) {
      err = e as ConfigLoadError;
    }
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(err!.detail.kind).toBe('version_error');
    expect(err!.detail.message).toMatch(/version/i);
    expect(err!.detail.message).toMatch(/"1"/);
  });

  it('rejects version: "2" and names both the received and required values', () => {
    const yaml = MINIMAL_VALID.replace('version: "1"', 'version: "2"');
    let err: ConfigLoadError | undefined;
    try {
      loadConfig(writeYaml(yaml));
    } catch (e) {
      err = e as ConfigLoadError;
    }
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(err!.detail.kind).toBe('version_error');
    if (err!.detail.kind === 'version_error') {
      expect(err!.detail.received).toBe('2');
    }
    // Message must name required ("1") and received ("2")
    expect(err!.detail.message).toContain('"1"');
    expect(err!.detail.message).toContain('"2"');
  });

  it('rejects version: 1 (unquoted integer) and names the received value', () => {
    // YAML 1.2 parses bare `1` as number; the harness requires the string "1"
    const yaml = MINIMAL_VALID.replace('version: "1"', 'version: 1');
    let err: ConfigLoadError | undefined;
    try {
      loadConfig(writeYaml(yaml));
    } catch (e) {
      err = e as ConfigLoadError;
    }
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(err!.detail.kind).toBe('version_error');
    if (err!.detail.kind === 'version_error') {
      expect(err!.detail.received).toBe(1); // numeric, not string
    }
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 4 — relative paths resolved using config dir, not cwd
// ---------------------------------------------------------------------------

describe('loadConfig — path resolution', () => {
  it('resolves prompt_template relative to config dir, not process.cwd()', () => {
    const fp = writeYaml(MINIMAL_VALID);
    const cfg = loadConfig(fp);
    const expected = path.join(tmpDir, 'prompts/implement.md');
    expect(cfg.phases['implement'].prompt_template).toBe(expected);
    // Must NOT be relative to process.cwd()
    expect(cfg.phases['implement'].prompt_template).not.toBe(
      path.join(process.cwd(), 'prompts/implement.md'),
    );
  });

  it('resolves artifact schema path to absolute', () => {
    const yaml = `\
version: "1"
project:
  name: test
pipeline:
  stages:
    - id: main
      run: once
      phases: [plan]
phases:
  plan:
    command: claude
    args: []
    prompt_template: prompts/plan.md
    output_artifacts:
      - path: features.json
        schema: schemas/features.schema.json
`;
    const fp = writeYaml(yaml);
    const cfg = loadConfig(fp);
    expect(cfg.phases['plan'].output_artifacts?.[0].schema).toBe(
      path.join(tmpDir, 'schemas/features.schema.json'),
    );
  });

  it('resolves worktrees.teardown.script to absolute', () => {
    const yaml = `\
version: "1"
project:
  name: test
pipeline:
  stages:
    - id: main
      run: once
      phases: [impl]
phases:
  impl:
    command: claude
    args: []
    prompt_template: prompts/impl.md
worktrees:
  teardown:
    script: .yoke/teardown.sh
`;
    const fp = writeYaml(yaml);
    const cfg = loadConfig(fp);
    expect(cfg.worktrees?.teardown?.script).toBe(
      path.join(tmpDir, '.yoke/teardown.sh'),
    );
  });

  it('attaches configDir equal to the .yoke.yml directory', () => {
    const fp = writeYaml(MINIMAL_VALID);
    const cfg = loadConfig(fp);
    expect(cfg.configDir).toBe(tmpDir);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 5 — empty / invalid YAML returns structured error
// ---------------------------------------------------------------------------

describe('loadConfig — parse errors', () => {
  it('returns a parse_error for an empty file', () => {
    const fp = writeYaml('');
    let err: ConfigLoadError | undefined;
    try {
      loadConfig(fp);
    } catch (e) {
      err = e as ConfigLoadError;
    }
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(err!.detail.kind).toBe('parse_error');
  });

  it('returns a parse_error for a whitespace-only file', () => {
    const fp = writeYaml('   \n\n  ');
    let err: ConfigLoadError | undefined;
    try {
      loadConfig(fp);
    } catch (e) {
      err = e as ConfigLoadError;
    }
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(err!.detail.kind).toBe('parse_error');
  });

  it('returns a parse_error for syntactically invalid YAML', () => {
    const fp = writeYaml('key: [unclosed\n  - item\nnot: closed: properly:');
    let err: ConfigLoadError | undefined;
    try {
      loadConfig(fp);
    } catch (e) {
      err = e as ConfigLoadError;
    }
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(err!.detail.kind).toBe('parse_error');
  });

  it('returns a not_found error when the file does not exist', () => {
    let err: ConfigLoadError | undefined;
    try {
      loadConfig('/nonexistent/path/.yoke.yml');
    } catch (e) {
      err = e as ConfigLoadError;
    }
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(err!.detail.kind).toBe('not_found');
  });

  it('does not throw an unhandled exception for any failure — always ConfigLoadError', () => {
    const cases = [
      () => loadConfig('/nonexistent/.yoke.yml'),
      () => loadConfig(writeYaml('')),
      () => loadConfig(writeYaml('bad: [yaml')),
      () => loadConfig(writeYaml(MINIMAL_VALID.replace('version: "1"\n', ''))),
      () => loadConfig(writeYaml(MINIMAL_VALID + 'extra: key\n')),
    ];
    for (const fn of cases) {
      expect(fn).toThrowError(ConfigLoadError);
    }
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 6 — AJV error messages include schema path + value
// ---------------------------------------------------------------------------

describe('loadConfig — AJV error message quality', () => {
  it('validation_error message includes the AJV schema path (#/...)', () => {
    const fp = writeYaml(MINIMAL_VALID + 'rogue_key: 42\n');
    let err: ConfigLoadError | undefined;
    try {
      loadConfig(fp);
    } catch (e) {
      err = e as ConfigLoadError;
    }
    expect(err!.detail.kind).toBe('validation_error');
    // Must contain a JSON schema pointer starting with #/
    expect(err!.detail.message).toMatch(/#\//);
  });

  it('validation_error errors array carries instancePath and schemaPath per AJV error', () => {
    const fp = writeYaml(MINIMAL_VALID + 'rogue_key: 42\n');
    let err: ConfigLoadError | undefined;
    try {
      loadConfig(fp);
    } catch (e) {
      err = e as ConfigLoadError;
    }
    expect(err!.detail.kind).toBe('validation_error');
    if (err!.detail.kind === 'validation_error') {
      expect(err!.detail.errors.length).toBeGreaterThan(0);
      const first = err!.detail.errors[0];
      expect(typeof first.instancePath).toBe('string');
      expect(typeof first.schemaPath).toBe('string');
      expect(first.schemaPath).toMatch(/^#\//);
    }
  });
});
