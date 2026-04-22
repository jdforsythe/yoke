/**
 * Graph-view status → Tailwind chip class map.
 *
 * Reuses the FeatureBoard palette so Graph and List tabs share the same
 * color vocabulary. Every GraphNodeStatus is also a valid State, so this
 * is a thin delegation layer kept for call-site symmetry with the rest of
 * the GraphPane.
 */

import type { GraphNodeStatus } from '../../../../shared/types/graph';
import { itemStatusClass } from '../FeatureBoard/itemStatus';

export function graphStatusClass(status: GraphNodeStatus): string {
  return itemStatusClass(status);
}
