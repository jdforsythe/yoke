/**
 * BlockRing — fixed-capacity ring buffer for RenderBlock eviction.
 *
 * Provides O(1) amortized push (evicts the oldest block when at capacity via
 * head-pointer advance — no Array.shift() or physical element moves).
 * Physical indices in the backing array are stable until slots are recycled,
 * enabling O(1) lookup via an external blockId → physIdx Map.
 *
 * Callers must clone() before mutating to preserve pure-reducer immutability.
 */

import type { RenderBlock } from './types';

export class BlockRing {
  /** Backing array, indexed by physical position 0..cap-1. */
  private _buf: (RenderBlock | null)[];
  /** Physical index of the oldest live block. */
  private _head = 0;
  /** Number of live blocks currently in the ring. */
  private _len = 0;
  /** Fixed capacity; cannot be changed after construction. */
  readonly cap: number;

  constructor(cap: number, src?: BlockRing) {
    this.cap = cap;
    if (src) {
      // Clone constructor — O(cap).
      this._buf = [...src._buf] as (RenderBlock | null)[];
      this._head = src._head;
      this._len = src._len;
    } else {
      this._buf = new Array<RenderBlock | null>(cap).fill(null);
    }
  }

  get length(): number {
    return this._len;
  }

  /**
   * Push a block onto the ring.
   *
   * If the ring is at capacity, advances the head pointer (O(1)) — the
   * evicted block's slot is immediately available for reuse.
   *
   * Returns the physical index where the new block was stored, plus any
   * evicted block (null if no eviction occurred).
   *
   * O(1) amortized — NO Array.shift(), NO physical element moves.
   */
  push(block: RenderBlock): { physIdx: number; evicted: RenderBlock | null } {
    let evicted: RenderBlock | null = null;
    if (this._len === this.cap) {
      // Evict: advance head pointer (O(1) — the defining property of this class).
      evicted = this._buf[this._head]!;
      this._head = (this._head + 1) % this.cap;
    } else {
      this._len++;
    }
    // Tail of the live window after the length adjustment.
    const physIdx = (this._head + this._len - 1) % this.cap;
    this._buf[physIdx] = block;
    return { physIdx, evicted };
  }

  /**
   * Read the block at the given physical index.
   * O(1). Returns null if the slot is unoccupied.
   */
  getPhys(physIdx: number): RenderBlock | null {
    return this._buf[physIdx];
  }

  /**
   * Overwrite the block at the given physical index.
   * O(1). Caller is responsible for ensuring the index is in the live window.
   */
  setPhys(physIdx: number, block: RenderBlock): void {
    this._buf[physIdx] = block;
  }

  /**
   * Check whether a physical index is still in the live window.
   * O(1). Use this to detect stale entries in an external Map after eviction.
   */
  isLive(physIdx: number): boolean {
    if (this._len === 0) return false;
    const end = (this._head + this._len) % this.cap;
    if (this._head < end) {
      // No wrap-around.
      return physIdx >= this._head && physIdx < end;
    }
    // Wrap-around case.
    return physIdx >= this._head || physIdx < end;
  }

  /**
   * Materialise the live blocks into a plain array in oldest-first order.
   * O(n). Should only be called at render time, not per-frame.
   */
  toArray(): RenderBlock[] {
    const result: RenderBlock[] = new Array(this._len);
    for (let i = 0; i < this._len; i++) {
      result[i] = this._buf[(this._head + i) % this.cap]!;
    }
    return result;
  }

  /**
   * Create a full copy of this ring.
   * O(cap). Clone before mutating to maintain pure-reducer immutability.
   */
  clone(): BlockRing {
    return new BlockRing(this.cap, this);
  }
}
