/**
 * Graph-view status → Tailwind chip class map.
 *
 * Reuses the FeatureBoard palette so Graph and List tabs share the same
 * color vocabulary for states that exist in both. `skipped` is graph-only
 * and gets a muted gray variant that visually deprioritises pruned branches.
 */

import type { GraphNodeStatus } from '../../../../shared/types/graph';
import { itemStatusClass } from '../FeatureBoard/itemStatus';

const GRAPH_ONLY: Partial<Record<GraphNodeStatus, string>> = {
  skipped: 'bg-gray-700/20 text-gray-500 line-through',
};

export function graphStatusClass(status: GraphNodeStatus): string {
  return GRAPH_ONLY[status] ?? itemStatusClass(status);
}
