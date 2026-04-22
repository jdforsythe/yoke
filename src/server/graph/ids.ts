/**
 * Deterministic node/edge id helpers for the graph.
 *
 * IDs must be stable across derivation passes so that `deriveFromHistory`
 * produces the same graph shape as an incremental `applyEvent` stream for the
 * same history.  Every id is a pure function of its coordinates.
 */

export const stageNodeId = (stageId: string): string => `stage:${stageId}`;

export const itemNodeId = (stageId: string, itemId: string): string =>
  `item:${stageId}:${itemId}`;

export const phaseNodeId = (
  stageId: string,
  itemId: string | null,
  phase: string,
): string => `phase:${stageId}:${itemId ?? '_'}:${phase}`;

export const sessionNodeId = (sessionId: string): string => `session:${sessionId}`;

export const prepostNodeId = (prepostRunId: string): string => `prepost:${prepostRunId}`;

export const edgeId = (
  kind: string,
  from: string,
  to: string,
  disambiguator?: string,
): string => `e:${kind}:${from}->${to}${disambiguator ? `:${disambiguator}` : ''}`;
