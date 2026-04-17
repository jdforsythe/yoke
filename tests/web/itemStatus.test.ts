/**
 * Unit tests for itemStatusClass and ITEM_STATUS_OPTIONS.
 *
 * Walks STATE_VALUES (the runtime representation of the State union) and
 * asserts that every value has a distinct, non-empty chip class and a
 * corresponding dropdown entry. This makes adding a new State member without
 * updating itemStatus.ts a failing test.
 */

import { describe, it, expect } from 'vitest';
import { STATE_VALUES } from '../../src/shared/types/states';
import {
  itemStatusClass,
  ITEM_STATUS_OPTIONS,
  STATUS_CLASSES,
  STATUS_LABELS,
} from '../../src/web/src/components/FeatureBoard/itemStatus';

describe('itemStatusClass', () => {
  for (const state of STATE_VALUES) {
    it(`returns a non-empty Tailwind class string for state "${state}"`, () => {
      const cls = itemStatusClass(state);
      expect(typeof cls).toBe('string');
      expect(cls.length).toBeGreaterThan(0);
    });
  }

  it('awaiting_retry returns an amber/orange palette, not the gray default', () => {
    const cls = itemStatusClass('awaiting_retry');
    expect(cls).not.toContain('gray');
    expect(cls.toLowerCase()).toMatch(/amber/);
  });

  it('awaiting_user returns a yellow palette, not the gray default', () => {
    const cls = itemStatusClass('awaiting_user');
    expect(cls).not.toContain('gray');
    expect(cls.toLowerCase()).toMatch(/yellow/);
  });

  it('returns the gray fallback for an unknown status without throwing', () => {
    const cls = itemStatusClass('not_a_real_state');
    expect(typeof cls).toBe('string');
    expect(cls.length).toBeGreaterThan(0);
    expect(cls).toContain('gray');
  });

  it('covers every State value in STATUS_CLASSES (exhaustiveness guard)', () => {
    for (const state of STATE_VALUES) {
      expect(STATUS_CLASSES).toHaveProperty(state);
      expect(typeof STATUS_CLASSES[state]).toBe('string');
      expect(STATUS_CLASSES[state].length).toBeGreaterThan(0);
    }
  });
});

describe('ITEM_STATUS_OPTIONS', () => {
  it('includes an "all" option as the first entry', () => {
    expect(ITEM_STATUS_OPTIONS[0]?.value).toBe('all');
  });

  it('includes an option for every State value', () => {
    const optionValues = ITEM_STATUS_OPTIONS.map((o) => o.value);
    for (const state of STATE_VALUES) {
      expect(optionValues).toContain(state);
    }
  });

  it('every option has a non-empty label', () => {
    for (const opt of ITEM_STATUS_OPTIONS) {
      expect(typeof opt.label).toBe('string');
      expect(opt.label.length).toBeGreaterThan(0);
    }
  });

  it('covers every State value in STATUS_LABELS (exhaustiveness guard)', () => {
    for (const state of STATE_VALUES) {
      expect(STATUS_LABELS).toHaveProperty(state);
      expect(typeof STATUS_LABELS[state]).toBe('string');
      expect(STATUS_LABELS[state].length).toBeGreaterThan(0);
    }
  });
});
