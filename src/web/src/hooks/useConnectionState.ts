import { useState, useEffect } from 'react';
import { getClient } from '@/ws/client';
import type { ConnectionState } from '@/ws/types';

/**
 * Returns the current WebSocket connection state, updating reactively
 * whenever the client's connection state changes.
 */
export function useConnectionState(): ConnectionState {
  const [state, setState] = useState<ConnectionState>(() => getClient().getConnectionState());

  useEffect(() => {
    return getClient().onStateChange(setState);
  }, []);

  return state;
}
