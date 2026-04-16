import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveConfig } from '../../src/server/config/resolve.js';
import type { RawConfig } from '../../src/shared/types/config.js';

const BASE = '/project/root';

/** Minimal valid RawConfig for use in resolver tests (no file I/O needed). */
function minimal(overrides: Partial<RawConfig> = {}): RawConfig {
  return {
    version: '1',
    project: { name: 'test' },
    pipeline: {
      stages: [{ id: 'main', run: 'once', phases: ['impl'] }],
    },
    phases: {
      impl: {
        command: 'claude',
        args: ['--print'],
        prompt_template: 'prompts/impl.md',
      },
    },
    ...overrides,
  };
}

describe('resolveConfig — path resolution', () => {
  it('resolves a relative prompt_template to an absolute path', () => {
    const resolved = resolveConfig(minimal(), BASE);
    expect(resolved.phases['impl'].prompt_template).toBe(
      path.join(BASE, 'prompts/impl.md'),
    );
  });

  it('leaves an already-absolute prompt_template unchanged', () => {
    const raw = minimal({
      phases: {
        impl: { command: 'claude', args: [], prompt_template: '/abs/path.md' },
      },
    });
    const resolved = resolveConfig(raw, BASE);
    expect(resolved.phases['impl'].prompt_template).toBe('/abs/path.md');
  });

  it('resolves a relative artifact schema path', () => {
    const raw = minimal({
      phases: {
        impl: {
          command: 'claude',
          args: [],
          prompt_template: 'p.md',
          output_artifacts: [{ path: 'out.json', schema: 'schemas/out.schema.json' }],
        },
      },
    });
    const resolved = resolveConfig(raw, BASE);
    expect(resolved.phases['impl'].output_artifacts?.[0].schema).toBe(
      path.join(BASE, 'schemas/out.schema.json'),
    );
  });

  it('leaves an absolute artifact schema path unchanged', () => {
    const raw = minimal({
      phases: {
        impl: {
          command: 'claude',
          args: [],
          prompt_template: 'p.md',
          output_artifacts: [{ path: 'out.json', schema: '/abs/schema.json' }],
        },
      },
    });
    const resolved = resolveConfig(raw, BASE);
    expect(resolved.phases['impl'].output_artifacts?.[0].schema).toBe('/abs/schema.json');
  });

  it('resolves a relative cwd to an absolute path', () => {
    const raw = minimal({
      phases: {
        impl: {
          command: 'claude',
          args: [],
          prompt_template: 'p.md',
          cwd: 'subdir',
        },
      },
    });
    const resolved = resolveConfig(raw, BASE);
    expect(resolved.phases['impl'].cwd).toBe(path.join(BASE, 'subdir'));
  });

  it('leaves absent cwd undefined', () => {
    const resolved = resolveConfig(minimal(), BASE);
    expect(resolved.phases['impl'].cwd).toBeUndefined();
  });

  it('resolves worktrees.teardown.script to an absolute path', () => {
    const raw = minimal({
      worktrees: { teardown: { script: '.yoke/teardown.sh' } },
    });
    const resolved = resolveConfig(raw, BASE);
    expect(resolved.worktrees?.teardown?.script).toBe(
      path.join(BASE, '.yoke/teardown.sh'),
    );
  });

  it('leaves an absolute teardown script unchanged', () => {
    const raw = minimal({
      worktrees: { teardown: { script: '/scripts/teardown.sh' } },
    });
    const resolved = resolveConfig(raw, BASE);
    expect(resolved.worktrees?.teardown?.script).toBe('/scripts/teardown.sh');
  });
});

describe('resolveConfig — configDir', () => {
  it('attaches configDir to the result', () => {
    const resolved = resolveConfig(minimal(), BASE);
    expect(resolved.configDir).toBe(BASE);
  });
});

describe('resolveConfig — immutability', () => {
  it('does NOT mutate the original raw config', () => {
    const raw = minimal();
    const originalTemplate = raw.phases['impl'].prompt_template;
    resolveConfig(raw, BASE);
    // Original must still be relative
    expect(raw.phases['impl'].prompt_template).toBe(originalTemplate);
  });
});

describe('resolveConfig — items_from is NOT resolved', () => {
  it('leaves stage.items_from as-is (worktree-relative, unknown at load time)', () => {
    const raw = minimal({
      pipeline: {
        stages: [
          {
            id: 'items-stage',
            run: 'per-item',
            phases: ['impl'],
            items_from: 'docs/features.json',
            items_list: '$.features',
            items_id: '$.id',
          },
        ],
      },
    });
    const resolved = resolveConfig(raw, BASE);
    expect(resolved.pipeline.stages[0].items_from).toBe('docs/features.json');
  });
});

describe('resolveConfig — multiple phases', () => {
  it('resolves paths in every phase, not just the first', () => {
    const raw: RawConfig = {
      version: '1',
      project: { name: 'test' },
      pipeline: {
        stages: [{ id: 'main', run: 'once', phases: ['plan', 'implement'] }],
      },
      phases: {
        plan: { command: 'claude', args: [], prompt_template: 'prompts/plan.md' },
        implement: {
          command: 'claude',
          args: [],
          prompt_template: 'prompts/implement.md',
          output_artifacts: [{ path: 'handoff.json', schema: 'schemas/handoff.schema.json' }],
        },
      },
    };
    const resolved = resolveConfig(raw, BASE);
    expect(resolved.phases['plan'].prompt_template).toBe(path.join(BASE, 'prompts/plan.md'));
    expect(resolved.phases['implement'].prompt_template).toBe(
      path.join(BASE, 'prompts/implement.md'),
    );
    expect(resolved.phases['implement'].output_artifacts?.[0].schema).toBe(
      path.join(BASE, 'schemas/handoff.schema.json'),
    );
  });
});
