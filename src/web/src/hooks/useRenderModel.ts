import { useSyncExternalStore } from 'react';
import { getSnapshot, subscribe } from '@/store/renderStore';
import type { RenderModelState } from '@/store/types';

/**
 * Returns the current render-model state, updating reactively whenever a
 * frame is dispatched to the render store.
 *
 * Backed by useSyncExternalStore for concurrent-safe reads.
 */
export function useRenderModel(): RenderModelState {
  return useSyncExternalStore(subscribe, getSnapshot);
}
