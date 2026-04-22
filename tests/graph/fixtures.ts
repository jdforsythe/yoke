import type { Pipeline as TPipeline, Phase as TPhase } from '../../src/shared/types/config.js';

export type { TPipeline as Pipeline, TPhase as Phase };

export function makePhase(overrides: Partial<TPhase> = {}): TPhase {
  return {
    command: 'claude',
    args: ['--stream-json'],
    prompt_template: '/tmp/prompt.md',
    ...overrides,
  };
}

export function onceStageOnePhase(): { pipeline: TPipeline; phases: Record<string, TPhase> } {
  return {
    pipeline: {
      stages: [{ id: 'plan', run: 'once', phases: ['plan'] }],
    },
    phases: { plan: makePhase() },
  };
}

export function perItemStageWithPrePost(): {
  pipeline: TPipeline;
  phases: Record<string, TPhase>;
} {
  return {
    pipeline: {
      stages: [
        {
          id: 'impl',
          run: 'per-item',
          phases: ['implement'],
          items_from: 'items.json',
          items_list: '$.items',
          items_id: '$.id',
        },
      ],
    },
    phases: {
      implement: makePhase({
        pre: [{ name: 'check-workspace', run: ['bash', '-c', 'true'], actions: { '0': 'continue' } }],
        post: [
          {
            name: 'check-verdict',
            run: ['bash', '-c', 'true'],
            actions: {
              '0': 'continue',
              '1': { goto: 'implement' },
            },
          },
        ],
      }),
    },
  };
}

export function implementReviewWithGoto(): {
  pipeline: TPipeline;
  phases: Record<string, TPhase>;
} {
  return {
    pipeline: {
      stages: [
        {
          id: 'work',
          run: 'once',
          phases: ['implement', 'review'],
        },
      ],
    },
    phases: {
      implement: makePhase(),
      review: makePhase({
        post: [
          {
            name: 'check-verdict',
            run: ['bash', '-c', 'true'],
            actions: {
              '0': 'continue',
              '1': { goto: 'implement', max_revisits: 3 },
            },
          },
        ],
      }),
    },
  };
}

export function multiGotoPipeline(): {
  pipeline: TPipeline;
  phases: Record<string, TPhase>;
} {
  return {
    pipeline: {
      stages: [
        { id: 'work', run: 'once', phases: ['plan', 'implement', 'review'] },
      ],
    },
    phases: {
      plan: makePhase(),
      implement: makePhase(),
      review: makePhase({
        post: [
          {
            name: 'check-verdict',
            run: ['bash', '-c', 'true'],
            actions: {
              '0': 'continue',
              '1': { goto: 'implement', max_revisits: 3 },
              '2': { goto: 'plan', max_revisits: 1 },
            },
          },
        ],
      }),
    },
  };
}

export function multiStagePipeline(): {
  pipeline: TPipeline;
  phases: Record<string, TPhase>;
} {
  return {
    pipeline: {
      stages: [
        { id: 'plan', run: 'once', phases: ['plan'] },
        { id: 'impl', run: 'once', phases: ['implement'] },
        { id: 'review', run: 'once', phases: ['review'] },
      ],
    },
    phases: {
      plan: makePhase(),
      implement: makePhase(),
      review: makePhase(),
    },
  };
}
