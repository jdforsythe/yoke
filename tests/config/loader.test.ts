import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { listTemplates, loadTemplate } from '../../src/server/config/loader.js';
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

/**
 * Write a template file to <tmpDir>/.yoke/templates/<name>.yml.
 * Returns the template name so callers can pass it directly to loadTemplate.
 */
function writeTemplate(content: string, name = 'default'): string {
  const dir = path.join(tmpDir, '.yoke', 'templates');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.yml`), content, 'utf8');
  return name;
}

// ---------------------------------------------------------------------------
// Minimal valid template used as the happy-path baseline
// ---------------------------------------------------------------------------

const MINIMAL_VALID = `\
version: "1"
template:
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
// listTemplates — happy path (AC: listTemplates returns every *.yml)
// ---------------------------------------------------------------------------

describe('listTemplates — happy path', () => {
  it('returns an empty array when .yoke/templates/ does not exist', () => {
    const result = listTemplates(tmpDir);
    expect(result).toEqual([]);
  });

  it('returns one entry when a single valid template is present', () => {
    writeTemplate(MINIMAL_VALID, 'default');
    const result = listTemplates(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('default');
    expect(result[0].description).toBeNull();
    expect(result[0].path).toBe(path.join(tmpDir, '.yoke', 'templates', 'default.yml'));
  });

  it('returns description when template.description is set', () => {
    const yaml = MINIMAL_VALID.replace(
      'template:\n  name: test-project',
      'template:\n  name: test-project\n  description: A great template',
    );
    writeTemplate(yaml, 'awesome');
    const [entry] = listTemplates(tmpDir);
    expect(entry.description).toBe('A great template');
    expect(entry.name).toBe('awesome');
  });

  it('returns multiple entries for multiple template files', () => {
    writeTemplate(MINIMAL_VALID, 'alpha');
    writeTemplate(MINIMAL_VALID, 'beta');
    const result = listTemplates(tmpDir);
    const names = result.map((r) => r.name).sort();
    expect(names).toEqual(['alpha', 'beta']);
  });

  it('skips invalid YAML files with a warning instead of throwing', () => {
    writeTemplate(MINIMAL_VALID, 'valid');
    writeTemplate('bad: [yaml\n  not closed', 'broken');
    // Should not throw; should return only the valid entry.
    let result: ReturnType<typeof listTemplates> = [];
    expect(() => {
      result = listTemplates(tmpDir);
    }).not.toThrow();
    expect(result.some((r) => r.name === 'valid')).toBe(true);
    // broken may be skipped (YAML parse error) — no assertion on its presence
  });
});

// ---------------------------------------------------------------------------
// listTemplates — migration error
// ---------------------------------------------------------------------------

describe('listTemplates — root .yoke.yml rejected', () => {
  it('throws migration_error when .yoke.yml exists at repo root', () => {
    fs.writeFileSync(path.join(tmpDir, '.yoke.yml'), MINIMAL_VALID, 'utf8');
    let err: ConfigLoadError | undefined;
    try {
      listTemplates(tmpDir);
    } catch (e) {
      err = e as ConfigLoadError;
    }
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(err!.detail.kind).toBe('migration_error');
    expect(err!.detail.message).toMatch(/\.yoke\.yml at repo root is no longer supported/);
    expect(err!.detail.message).toMatch(/\.yoke\/templates\//);
  });
});

// ---------------------------------------------------------------------------
// loadTemplate — happy path (AC: loadTemplate validates + resolves)
// ---------------------------------------------------------------------------

describe('loadTemplate — valid configs', () => {
  it('parses a minimal valid template without throwing', () => {
    writeTemplate(MINIMAL_VALID);
    const cfg = loadTemplate(tmpDir, 'default');
    expect(cfg.version).toBe('1');
    expect(cfg.template.name).toBe('test-project');
    expect(cfg.pipeline.stages[0].id).toBe('main');
  });

  it('resolves prompt_template relative to configDir (repo root), not templates dir', () => {
    writeTemplate(MINIMAL_VALID);
    const cfg = loadTemplate(tmpDir, 'default');
    const expected = path.join(tmpDir, 'prompts/implement.md');
    expect(cfg.phases['implement'].prompt_template).toBe(expected);
  });

  it('sets configDir to the repo root (configDir argument), not the template file directory', () => {
    writeTemplate(MINIMAL_VALID);
    const cfg = loadTemplate(tmpDir, 'default');
    expect(cfg.configDir).toBe(tmpDir);
  });

  it('parses a config with all major optional sections without throwing', () => {
    const yaml = `\
version: "1"
template:
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
    writeTemplate(yaml);
    expect(() => loadTemplate(tmpDir, 'default')).not.toThrow();
    const cfg = loadTemplate(tmpDir, 'default');
    expect(cfg.worktrees?.base_dir).toBe('.worktrees');
  });
});

// ---------------------------------------------------------------------------
// loadTemplate — not_found (AC: loadTemplate missing file)
// ---------------------------------------------------------------------------

describe('loadTemplate — missing file', () => {
  it('throws not_found when the template file does not exist', () => {
    let err: ConfigLoadError | undefined;
    try {
      loadTemplate(tmpDir, 'nonexistent');
    } catch (e) {
      err = e as ConfigLoadError;
    }
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(err!.detail.kind).toBe('not_found');
    if (err!.detail.kind === 'not_found') {
      expect(err!.detail.path).toContain('nonexistent.yml');
    }
  });
});

// ---------------------------------------------------------------------------
// loadTemplate — migration error (AC: root .yoke.yml rejected)
// ---------------------------------------------------------------------------

describe('loadTemplate — root .yoke.yml rejected', () => {
  it('throws migration_error when .yoke.yml exists at repo root', () => {
    fs.writeFileSync(path.join(tmpDir, '.yoke.yml'), MINIMAL_VALID, 'utf8');
    let err: ConfigLoadError | undefined;
    try {
      loadTemplate(tmpDir, 'default');
    } catch (e) {
      err = e as ConfigLoadError;
    }
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(err!.detail.kind).toBe('migration_error');
    expect(err!.detail.message).toMatch(/\.yoke\.yml at repo root is no longer supported/);
  });
});

// ---------------------------------------------------------------------------
// loadTemplate — unknown keys rejected
// ---------------------------------------------------------------------------

describe('loadTemplate — unknown keys', () => {
  it('rejects an unknown top-level key with a validation_error naming it', () => {
    writeTemplate(MINIMAL_VALID + 'totally_unknown_key: value\n');
    let err: ConfigLoadError | undefined;
    try {
      loadTemplate(tmpDir, 'default');
    } catch (e) {
      err = e as ConfigLoadError;
    }
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(err!.detail.kind).toBe('validation_error');
    expect(err!.detail.message).toMatch(/totally_unknown_key/);
  });

  it('rejects the old project: key with a readable error that names "project"', () => {
    // AC-6: a stale config using `project:` instead of `template:` must produce
    // an AJV error that names the unknown property so the user knows what to fix.
    const staleYaml = MINIMAL_VALID.replace('template:\n  name: test-project\n', 'project:\n  name: test-project\n');
    writeTemplate(staleYaml);
    let err: ConfigLoadError | undefined;
    try {
      loadTemplate(tmpDir, 'default');
    } catch (e) {
      err = e as ConfigLoadError;
    }
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(err!.detail.kind).toBe('validation_error');
    expect(err!.detail.message).toMatch(/project/);
  });

  it('rejects an unknown key inside a phase (additionalProperties:false at nested level)', () => {
    const yaml = MINIMAL_VALID.replace(
      '    prompt_template: prompts/implement.md',
      '    prompt_template: prompts/implement.md\n    bad_phase_key: oops',
    );
    writeTemplate(yaml);
    let err: ConfigLoadError | undefined;
    try {
      loadTemplate(tmpDir, 'default');
    } catch (e) {
      err = e as ConfigLoadError;
    }
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(err!.detail.kind).toBe('validation_error');
    expect(err!.detail.message).toMatch(/bad_phase_key/);
  });

  it('rejects an unknown key inside a pipeline stage', () => {
    const yaml = `\
version: "1"
template:
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
    writeTemplate(yaml);
    let err: ConfigLoadError | undefined;
    try {
      loadTemplate(tmpDir, 'default');
    } catch (e) {
      err = e as ConfigLoadError;
    }
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(err!.detail.kind).toBe('validation_error');
    expect(err!.detail.message).toMatch(/ghost_field/);
  });
});

// ---------------------------------------------------------------------------
// loadTemplate — version pin
// ---------------------------------------------------------------------------

describe('loadTemplate — version pin', () => {
  it('rejects a config missing the version field', () => {
    writeTemplate(MINIMAL_VALID.replace('version: "1"\n', ''));
    let err: ConfigLoadError | undefined;
    try {
      loadTemplate(tmpDir, 'default');
    } catch (e) {
      err = e as ConfigLoadError;
    }
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(err!.detail.kind).toBe('version_error');
    expect(err!.detail.message).toMatch(/version/i);
    expect(err!.detail.message).toMatch(/"1"/);
  });

  it('rejects version: "2" and names both the received and required values', () => {
    writeTemplate(MINIMAL_VALID.replace('version: "1"', 'version: "2"'));
    let err: ConfigLoadError | undefined;
    try {
      loadTemplate(tmpDir, 'default');
    } catch (e) {
      err = e as ConfigLoadError;
    }
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(err!.detail.kind).toBe('version_error');
    if (err!.detail.kind === 'version_error') {
      expect(err!.detail.received).toBe('2');
    }
    expect(err!.detail.message).toContain('"1"');
    expect(err!.detail.message).toContain('"2"');
  });

  it('rejects version: 1 (unquoted integer) and names the received value', () => {
    writeTemplate(MINIMAL_VALID.replace('version: "1"', 'version: 1'));
    let err: ConfigLoadError | undefined;
    try {
      loadTemplate(tmpDir, 'default');
    } catch (e) {
      err = e as ConfigLoadError;
    }
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(err!.detail.kind).toBe('version_error');
    if (err!.detail.kind === 'version_error') {
      expect(err!.detail.received).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// loadTemplate — path resolution
// ---------------------------------------------------------------------------

describe('loadTemplate — path resolution', () => {
  it('resolves prompt_template relative to config dir, not process.cwd()', () => {
    writeTemplate(MINIMAL_VALID);
    const cfg = loadTemplate(tmpDir, 'default');
    const expected = path.join(tmpDir, 'prompts/implement.md');
    expect(cfg.phases['implement'].prompt_template).toBe(expected);
    expect(cfg.phases['implement'].prompt_template).not.toBe(
      path.join(process.cwd(), 'prompts/implement.md'),
    );
  });

  it('resolves artifact schema path to absolute', () => {
    const yaml = `\
version: "1"
template:
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
    writeTemplate(yaml);
    const cfg = loadTemplate(tmpDir, 'default');
    expect(cfg.phases['plan'].output_artifacts?.[0].schema).toBe(
      path.join(tmpDir, 'schemas/features.schema.json'),
    );
  });

  it('resolves worktrees.teardown.script to absolute', () => {
    const yaml = `\
version: "1"
template:
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
    writeTemplate(yaml);
    const cfg = loadTemplate(tmpDir, 'default');
    expect(cfg.worktrees?.teardown?.script).toBe(
      path.join(tmpDir, '.yoke/teardown.sh'),
    );
  });

  it('attaches configDir equal to the repo root (first argument to loadTemplate)', () => {
    writeTemplate(MINIMAL_VALID);
    const cfg = loadTemplate(tmpDir, 'default');
    expect(cfg.configDir).toBe(tmpDir);
  });
});

// ---------------------------------------------------------------------------
// loadTemplate — parse errors
// ---------------------------------------------------------------------------

describe('loadTemplate — parse errors', () => {
  it('returns a parse_error for an empty file', () => {
    writeTemplate('');
    let err: ConfigLoadError | undefined;
    try {
      loadTemplate(tmpDir, 'default');
    } catch (e) {
      err = e as ConfigLoadError;
    }
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(err!.detail.kind).toBe('parse_error');
  });

  it('returns a parse_error for a whitespace-only file', () => {
    writeTemplate('   \n\n  ');
    let err: ConfigLoadError | undefined;
    try {
      loadTemplate(tmpDir, 'default');
    } catch (e) {
      err = e as ConfigLoadError;
    }
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(err!.detail.kind).toBe('parse_error');
  });

  it('returns a parse_error for syntactically invalid YAML', () => {
    writeTemplate('key: [unclosed\n  - item\nnot: closed: properly:');
    let err: ConfigLoadError | undefined;
    try {
      loadTemplate(tmpDir, 'default');
    } catch (e) {
      err = e as ConfigLoadError;
    }
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(err!.detail.kind).toBe('parse_error');
  });

  it('does not throw an unhandled exception for any failure — always ConfigLoadError', () => {
    writeTemplate('');
    const badYamlName = writeTemplate('bad: [yaml', 'badyaml');
    const missingVersionName = writeTemplate(MINIMAL_VALID.replace('version: "1"\n', ''), 'nover');
    const extraKeyName = writeTemplate(MINIMAL_VALID + 'extra: key\n', 'extrakey');
    const cases = [
      () => loadTemplate(tmpDir, 'nonexistent'),
      () => loadTemplate(tmpDir, 'default'),
      () => loadTemplate(tmpDir, badYamlName),
      () => loadTemplate(tmpDir, missingVersionName),
      () => loadTemplate(tmpDir, extraKeyName),
    ];
    for (const fn of cases) {
      expect(fn).toThrowError(ConfigLoadError);
    }
  });
});

// ---------------------------------------------------------------------------
// loadTemplate — AJV error message quality
// ---------------------------------------------------------------------------

describe('loadTemplate — AJV error message quality', () => {
  it('validation_error message includes the AJV schema path (#/...)', () => {
    writeTemplate(MINIMAL_VALID + 'rogue_key: 42\n');
    let err: ConfigLoadError | undefined;
    try {
      loadTemplate(tmpDir, 'default');
    } catch (e) {
      err = e as ConfigLoadError;
    }
    expect(err!.detail.kind).toBe('validation_error');
    expect(err!.detail.message).toMatch(/#\//);
  });

  it('validation_error errors array carries instancePath and schemaPath per AJV error', () => {
    writeTemplate(MINIMAL_VALID + 'rogue_key: 42\n');
    let err: ConfigLoadError | undefined;
    try {
      loadTemplate(tmpDir, 'default');
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

// ---------------------------------------------------------------------------
// loadTemplate — prepost actions map wildcard enforcement
// ---------------------------------------------------------------------------

describe('loadTemplate — prepost actions map wildcard enforcement', () => {
  it('rejects a post command whose actions map has no "*" key', () => {
    const yaml = `\
version: "1"
template:
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
    post:
      - name: check
        run: ["./check.sh"]
        actions:
          "0": continue
`;
    writeTemplate(yaml);
    let err: ConfigLoadError | undefined;
    try {
      loadTemplate(tmpDir, 'default');
    } catch (e) {
      err = e as ConfigLoadError;
    }
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(err!.detail.kind).toBe('validation_error');
  });

  it('rejects a pre command whose actions map has no "*" key', () => {
    const yaml = `\
version: "1"
template:
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
    pre:
      - name: lint
        run: ["./lint.sh"]
        actions:
          "0": continue
          "1": stop-and-ask
`;
    writeTemplate(yaml);
    let err: ConfigLoadError | undefined;
    try {
      loadTemplate(tmpDir, 'default');
    } catch (e) {
      err = e as ConfigLoadError;
    }
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(err!.detail.kind).toBe('validation_error');
  });

  it('accepts a post command whose actions map has a "*" key', () => {
    const yaml = `\
version: "1"
template:
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
    post:
      - name: check
        run: ["./check.sh"]
        actions:
          "0": continue
          "*": stop-and-ask
`;
    writeTemplate(yaml);
    expect(() => loadTemplate(tmpDir, 'default')).not.toThrow();
  });

  it('accepts an actions map with only a "*" key (covers all exit codes)', () => {
    const yaml = `\
version: "1"
template:
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
    post:
      - name: check
        run: ["./check.sh"]
        actions:
          "*": continue
`;
    writeTemplate(yaml);
    expect(() => loadTemplate(tmpDir, 'default')).not.toThrow();
  });
});
