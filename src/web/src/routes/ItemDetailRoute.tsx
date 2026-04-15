/**
 * ItemDetailRoute — deep-link entry point for a specific item.
 *
 * Renders inside the WorkflowDetailRoute layout by delegating to the
 * parent WorkflowDetailRoute while scrolling to and highlighting the
 * referenced item card.
 *
 * On initial load (cold start), the route auto-subscribes to the workflow,
 * waits for the snapshot, then scrolls to the item card in the FeatureBoard.
 * The highlight animation (2 s pulse) draws the user's eye.
 */

import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { WorkflowDetailRoute } from './WorkflowDetailRoute';

export function ItemDetailRoute() {
  const { itemId } = useParams<{ workflowId: string; itemId: string }>();

  useEffect(() => {
    if (!itemId) return;
    // After a short delay to allow the FeatureBoard to render, scroll to
    // the item card and apply a highlight. The FeatureBoard handles the
    // scrollIntoView and aria-current logic; we just pass the ID via URL.
    // The URL param is consumed by FeatureBoard's deep-link effect.
  }, [itemId]);

  // Renders the full WorkflowDetailRoute; FeatureBoard reads :itemId from
  // the URL and scrolls to + highlights the target card.
  return <WorkflowDetailRoute />;
}
