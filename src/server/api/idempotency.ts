/**
 * CommandId idempotency store.
 *
 * The WS `control` frame and HTTP `POST /api/workflows/:id/control` both carry
 * a client-generated `commandId` (uuid). A repeated id within 5 minutes MUST
 * return the previous response without re-executing the action.
 *
 * Implementation: in-memory Map with explicit TTL. Entries older than TTL_MS
 * are evicted lazily on each lookup. No persistence — idempotency window
 * resets on server restart, which is acceptable per the spec (5-min window
 * is a client-side safety net for network retries, not a durability contract).
 */

/** TTL for idempotency entries: 5 minutes. */
export const IDEMPOTENCY_TTL_MS = 5 * 60 * 1_000;

export interface IdempotencyEntry {
  /** Cached response to return on duplicate commandId. */
  response: unknown;
  /** Absolute wall-clock expiry (ms since epoch). */
  expiresAt: number;
}

export class IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();

  /**
   * Returns the cached response for commandId if it exists and has not yet
   * expired. Returns undefined if the entry is absent or expired (and evicts
   * stale entries on access so they don't accumulate).
   */
  get(commandId: string): unknown | undefined {
    const entry = this.entries.get(commandId);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(commandId);
      return undefined;
    }
    return entry.response;
  }

  /**
   * Records response for commandId. Subsequent calls to get() within
   * IDEMPOTENCY_TTL_MS will return this response without re-executing the
   * action. Calling set() again with the same id overwrites the entry.
   */
  set(commandId: string, response: unknown): void {
    this.entries.set(commandId, {
      response,
      expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
    });
  }

  /** Evicts all entries whose TTL has elapsed. Useful for periodic GC. */
  evictExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (now > entry.expiresAt) {
        this.entries.delete(id);
      }
    }
  }

  /** Current number of live (non-expired) entries. For testing / metrics. */
  get size(): number {
    this.evictExpired();
    return this.entries.size;
  }
}
