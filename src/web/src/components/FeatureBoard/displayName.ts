/**
 * Resolve the display name for a feature board item card.
 *
 * Fallback chain:
 *   - displayTitle (set by agent output) — highest priority
 *   - stableId (extracted from manifest items_id JSONPath by seeder)
 *   - 'Seeding…' — for per-item stage placeholder rows (stableId is null
 *     because the seeder hasn't run yet; the placeholder row will be replaced)
 *   - item.id — last resort for once-stage items with no title or stableId
 */
export function resolveItemDisplayName(
  item: { id: string; displayTitle: string | null; stableId: string | null },
  stageRun: 'once' | 'per-item' | undefined,
): string {
  const isPlaceholder = stageRun === 'per-item' && item.stableId === null;
  return item.displayTitle ?? item.stableId ?? (isPlaceholder ? 'Seeding\u2026' : item.id);
}
