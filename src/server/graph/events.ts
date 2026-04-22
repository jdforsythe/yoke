/**
 * GraphEvent — internal event union passed from scheduler/seeder into applyEvent.
 *
 * These are not WS frames; they are the abstract shape the graph mutation
 * layer consumes.  Each call site in the scheduler translates its existing
 * event/broadcast into one of these shapes and invokes applyEvent().
 */

import type { ResolvedAction } from '../../shared/types/graph.js';

export type GraphEvent =
  | {
      kind: 'item_seeded';
      stageId: string;
      items: Array<{
        itemId: string;
        stableId: string | null;
        displayTitle?: string | null;
        dependsOn?: string[];
      }>;
    }
  | {
      kind: 'session_started';
      stageId: string;
      itemId: string | null;
      phase: string;
      sessionId: string;
      attempt: number;
      parentSessionId: string | null;
      startedAt: string;
    }
  | {
      kind: 'session_ended';
      sessionId: string;
      endedAt: string;
      exitCode: number | null;
    }
  | {
      kind: 'prepost_ended';
      stageId: string;
      itemId: string | null;
      phase: string;
      when: 'pre' | 'post';
      commandName: string;
      prepostRunId: string;
      actionTaken: ResolvedAction | null;
    }
  | {
      kind: 'item_state';
      stageId: string;
      itemId: string;
      status: string;
      currentPhase: string | null;
    }
  | {
      kind: 'stage_started';
      stageId: string;
    }
  | {
      kind: 'stage_complete';
      stageId: string;
    }
  | {
      kind: 'workflow_status';
      status: string;
    };
