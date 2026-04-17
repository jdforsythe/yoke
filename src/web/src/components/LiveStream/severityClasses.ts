/**
 * Severity → Tailwind palette mapping for SystemNoticeBlock rendering.
 *
 * Extracted from SystemNoticeRenderer.tsx so the logic is testable without a
 * React/JSX toolchain. A `default` branch guarantees a non-nullable return
 * even when an unexpected severity slips through at runtime (defence in
 * depth against a past white-screen bug).
 */

import type { SystemNoticeBlock } from '../../store/types';

export interface SeverityPalette {
  readonly border: string;
  readonly bg: string;
  readonly text: string;
}

export function severityClasses(
  severity: SystemNoticeBlock['severity'],
): SeverityPalette {
  switch (severity) {
    case 'info':
      return { border: 'border-l-blue-500', bg: 'bg-blue-950/10', text: 'text-blue-300' };
    case 'warn':
    case 'requires_attention':
      return { border: 'border-l-amber-500', bg: 'bg-amber-950/10', text: 'text-amber-300' };
    case 'error':
      return { border: 'border-l-red-500', bg: 'bg-red-950/10', text: 'text-red-300' };
    default:
      // Defensive fallback for unexpected severities (e.g. undefined, future
      // values not yet in the type). Mirrors the `info` palette.
      return { border: 'border-l-blue-500', bg: 'bg-blue-950/10', text: 'text-blue-300' };
  }
}
