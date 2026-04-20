/**
 * Yoke WebSocket client module.
 *
 * Pure TypeScript — no React imports. Consumed by hooks and context.
 * Protocol: docs/design/protocol-websocket.md
 *
 * Key invariants:
 * - subscribe() stores subscription and sends frame if connected; hello handler
 *   re-subscribes all active subscriptions on reconnect.
 * - Deduplication: per-session high-water mark drops seq <= hwm frames.
 * - commandId cache: same logical control within 5 min reuses the same UUID.
 * - Reconnect: exponential backoff 100ms → 200ms → ... → 30s, with jitter.
 * - Max 4 concurrent subscriptions; extras receive SUBSCRIPTION_LIMIT error.
 */

import type {
  ServerFrame,
  ClientFrame,
  SubscribePayload,
  UnsubscribePayload,
  ControlPayload,
  AckPayload,
  PingPayload,
  ConnectionState,
  HelloPayload,
  BackfillTruncatedPayload,
  ErrorPayload,
} from './types';

export type FrameHandler = (frame: ServerFrame) => void;
type ConnectionStateHandler = (state: ConnectionState) => void;

const PROTOCOL_VERSION = 1 as const;
const MIN_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 30_000;
const COMMAND_CACHE_TTL_MS = 5 * 60 * 1_000;
const MAX_SUBSCRIPTIONS = 4;

interface SubscriptionState {
  hwm: number;
}

interface CommandCacheEntry {
  commandId: string;
  ts: number;
}

function getWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/stream`;
}

/** Exponential backoff with ±50% jitter — prevents thundering herd. */
function jitteredBackoff(attempt: number): number {
  const base = Math.min(MIN_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
  return base * (0.5 + Math.random() * 0.5);
}

export class YokeWsClient {
  private ws: WebSocket | null = null;
  private _state: ConnectionState = 'disconnected';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  /** Per-session high-water marks: sessionId → last applied seq */
  private readonly hwms = new Map<string, number>();

  /** Active subscriptions: workflowId → state */
  private readonly subs = new Map<string, SubscriptionState>();

  /** commandId cache for idempotency: action cache key → {commandId, ts} */
  private readonly commandCache = new Map<string, CommandCacheEntry>();

  /** Frame type → registered handlers */
  private readonly frameHandlers = new Map<string, FrameHandler[]>();

  /** Connection state change handlers */
  private readonly stateHandlers: ConnectionStateHandler[] = [];

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  connect(): void {
    this.stopped = false;
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return;
    this._connect();
  }

  disconnect(): void {
    this.stopped = true;
    this._clearTimer();
    this.ws?.close();
    this._setState('disconnected');
  }

  /**
   * Subscribe to workflow frames. Stores subscription and sends subscribe frame
   * if connected; hello handler re-sends on reconnect.
   */
  subscribe(workflowId: string, sinceSeq?: number): void {
    // Deduplication: already subscribed — do not send a duplicate subscribe frame.
    // Re-subscription after reconnect is handled by the hello handler directly.
    if (this.subs.has(workflowId)) return;
    if (this.subs.size >= MAX_SUBSCRIPTIONS) {
      // At cap — surface as an error event
      this._dispatchSynthetic({
        v: 1,
        type: 'error',
        seq: 0,
        ts: new Date().toISOString(),
        payload: { code: 'SUBSCRIPTION_LIMIT', message: 'Max 4 concurrent subscriptions' } satisfies ErrorPayload,
      });
      return;
    }
    const hwm = sinceSeq ?? this.hwms.get(workflowId) ?? 0;
    this.subs.set(workflowId, { hwm });
    if (this._state === 'connected') {
      this._sendSubscribe(workflowId, hwm > 0 ? hwm : undefined);
    }
  }

  unsubscribe(workflowId: string): void {
    this.subs.delete(workflowId);
    this._send({
      v: 1,
      type: 'unsubscribe',
      id: crypto.randomUUID(),
      payload: { workflowId } satisfies UnsubscribePayload,
    });
  }

  /**
   * Send a control frame. Generates an idempotent commandId reused within 5 min
   * for the same logical action. Returns the commandId.
   */
  sendControl(action: ControlPayload['action'], opts: Omit<ControlPayload, 'action'>): string {
    const cacheKey = `${opts.workflowId}:${action}:${opts.itemId ?? ''}:${opts.stageId ?? ''}`;
    const now = Date.now();
    const cached = this.commandCache.get(cacheKey);
    let commandId: string;
    if (cached && now - cached.ts < COMMAND_CACHE_TTL_MS) {
      commandId = cached.commandId;
    } else {
      commandId = crypto.randomUUID();
      this.commandCache.set(cacheKey, { commandId, ts: now });
    }
    this._send({
      v: 1,
      type: 'control',
      id: commandId,
      payload: { action, ...opts } satisfies ControlPayload,
    });
    return commandId;
  }

  sendAck(sessionId: string, lastAppliedSeq: number): void {
    this._send({
      v: 1,
      type: 'ack',
      id: crypto.randomUUID(),
      payload: { sessionId, lastAppliedSeq } satisfies AckPayload,
    });
  }

  ping(): void {
    this._send({
      v: 1,
      type: 'ping',
      id: crypto.randomUUID(),
      payload: { clientTs: new Date().toISOString() } satisfies PingPayload,
    });
  }

  getConnectionState(): ConnectionState {
    return this._state;
  }

  get subscriptionCount(): number {
    return this.subs.size;
  }

  atSubscriptionCap(): boolean {
    return this.subs.size >= MAX_SUBSCRIPTIONS;
  }

  /**
   * Register a handler for a specific server frame type.
   * Returns an unsubscribe function.
   */
  on(type: string, handler: FrameHandler): () => void {
    const list = this.frameHandlers.get(type) ?? [];
    list.push(handler);
    this.frameHandlers.set(type, list);
    return () => {
      const updated = (this.frameHandlers.get(type) ?? []).filter((h) => h !== handler);
      this.frameHandlers.set(type, updated);
    };
  }

  /**
   * Register a connection-state change handler.
   * Returns an unsubscribe function.
   */
  onStateChange(handler: ConnectionStateHandler): () => void {
    this.stateHandlers.push(handler);
    handler(this._state); // emit current state immediately
    return () => {
      const idx = this.stateHandlers.indexOf(handler);
      if (idx >= 0) this.stateHandlers.splice(idx, 1);
    };
  }

  // ---------------------------------------------------------------------------
  // Internal — connection lifecycle
  // ---------------------------------------------------------------------------

  private _connect(): void {
    if (this.stopped) return;
    this._setState(this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting');

    let ws: WebSocket;
    try {
      ws = new WebSocket(getWsUrl());
    } catch {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('message', (event: MessageEvent) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(event.data as string) as ServerFrame;
      } catch {
        console.warn('[yoke-ws] malformed frame dropped');
        return;
      }
      this._onFrame(frame);
    });

    ws.addEventListener('close', () => {
      if (!this.stopped && this._state !== 'version_mismatch') {
        this._scheduleReconnect();
      }
    });

    // error always fires before close; reconnect is handled in close handler
    ws.addEventListener('error', () => undefined);
  }

  private _onFrame(frame: ServerFrame): void {
    // Deduplication: per-session seq high-water mark
    if (frame.sessionId && frame.seq > 0) {
      const hwm = this.hwms.get(frame.sessionId) ?? 0;
      if (frame.seq <= hwm) return;
      this.hwms.set(frame.sessionId, frame.seq);
      // Update active subscription HWM so reconnect uses the latest seq
      for (const [wfId, sub] of this.subs) {
        if (frame.workflowId === wfId) {
          sub.hwm = Math.max(sub.hwm, frame.seq);
        }
      }
    }

    // Protocol-level routing
    switch (frame.type) {
      case 'hello': {
        const hello = frame.payload as HelloPayload;
        if (hello.protocolVersion !== PROTOCOL_VERSION) {
          this._setState('version_mismatch');
          this.ws?.close(4001, 'Protocol version mismatch');
          break;
        }
        this.reconnectAttempt = 0;
        this._setState('connected');
        // Re-subscribe all stored subscriptions (handles reconnect case)
        for (const [workflowId, sub] of this.subs) {
          this._sendSubscribe(workflowId, sub.hwm > 0 ? sub.hwm : undefined);
        }
        break;
      }
      case 'error': {
        const err = frame.payload as ErrorPayload;
        switch (err.code) {
          case 'PROTOCOL_MISMATCH':
            this._setState('version_mismatch');
            this.ws?.close();
            break;
          case 'SUBSCRIPTION_LIMIT':
            break; // surfaced to UI via frame handlers below
          case 'NOT_FOUND':
            // Workflow no longer exists — evict the stale subscription so it
            // is not re-sent on the next reconnect.
            if (frame.workflowId) this.subs.delete(frame.workflowId);
            break;
          case 'BAD_FRAME':
            console.warn('[yoke-ws] BAD_FRAME:', err.message);
            break;
          case 'INTERNAL':
            this.ws?.close(); // triggers reconnect via close handler
            break;
          default:
            console.warn('[yoke-ws] unknown error:', err.code, err.message);
            this.ws?.close(); // triggers reconnect via close handler
        }
        break;
      }
      case 'backfill.truncated': {
        const trunc = frame.payload as BackfillTruncatedPayload;
        this._fetchBackfill(trunc).catch(() => undefined);
        break;
      }
    }

    this._dispatch(frame);
  }

  private async _fetchBackfill(trunc: BackfillTruncatedPayload): Promise<void> {
    let url = trunc.httpFetchUrl;
    let hasMore = true;
    while (hasMore) {
      const res = await fetch(url);
      if (!res.ok) return;
      const data = (await res.json()) as {
        entries: string[];
        nextSeq: number;
        hasMore: boolean;
      };
      for (const entry of data.entries) {
        let f: ServerFrame;
        try {
          f = JSON.parse(entry) as ServerFrame;
        } catch {
          continue;
        }
        this._onFrame(f);
      }
      hasMore = data.hasMore;
      if (hasMore) {
        url = url.replace(/sinceSeq=\d+/, `sinceSeq=${data.nextSeq}`);
      }
    }
  }

  private _sendSubscribe(workflowId: string, sinceSeq: number | undefined): void {
    const payload: SubscribePayload = { workflowId };
    if (sinceSeq !== undefined && sinceSeq > 0) payload.sinceSeq = sinceSeq;
    this._send({ v: 1, type: 'subscribe', id: crypto.randomUUID(), payload });
  }

  private _send(frame: ClientFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  private _dispatchSynthetic(frame: ServerFrame): void {
    this._dispatch(frame);
  }

  private _dispatch(frame: ServerFrame): void {
    const handlers = this.frameHandlers.get(frame.type) ?? [];
    for (const h of handlers) {
      try {
        h(frame);
      } catch (e) {
        console.error('[yoke-ws] handler error', e);
      }
    }
  }

  private _setState(state: ConnectionState): void {
    if (this._state === state) return;
    this._state = state;
    for (const h of this.stateHandlers) {
      try {
        h(state);
      } catch (e) {
        console.error('[yoke-ws] state handler error', e);
      }
    }
  }

  private _scheduleReconnect(): void {
    const delay = jitteredBackoff(this.reconnectAttempt++);
    this._clearTimer();
    this._setState('reconnecting');
    this.reconnectTimer = setTimeout(() => this._connect(), delay);
  }

  private _clearTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _client: YokeWsClient | null = null;

export function getClient(): YokeWsClient {
  if (!_client) _client = new YokeWsClient();
  return _client;
}
