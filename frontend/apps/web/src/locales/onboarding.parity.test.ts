import { describe, it, expect } from 'vitest';
import en from './en/onboarding.json';
import es from './es/onboarding.json';
import pt from './pt/onboarding.json';
import hi from './hi/onboarding.json';

/** Flatten to dotted leaf keys, skipping `_meta` annotation blocks. */
const keys = (o: unknown, p = ''): string[] =>
  o && typeof o === 'object'
    ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
        k === '_meta' ? [] : keys(v, p ? `${p}.${k}` : k),
      )
    : [p];

/** The {{placeholders}} a template string declares, sorted for comparison. */
const placeholders = (s: string): string[] =>
  [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();

const leaf = (o: Record<string, unknown>, path: string): unknown =>
  path.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], o);

describe('onboarding i18n parity', () => {
  it('es matches en keys', () => expect(keys(es).sort()).toEqual(keys(en).sort()));
  it('pt matches en keys', () => expect(keys(pt).sort()).toEqual(keys(en).sort()));
  it('hi matches en keys', () => expect(keys(hi).sort()).toEqual(keys(en).sort()));

  it('es/pt/hi carry the same {{placeholders}} as en for every string', () => {
    for (const key of keys(en)) {
      const enVal = leaf(en as Record<string, unknown>, key);
      if (typeof enVal !== 'string') continue;
      const want = placeholders(enVal);
      expect(placeholders(leaf(es as Record<string, unknown>, key) as string)).toEqual(want);
      expect(placeholders(leaf(pt as Record<string, unknown>, key) as string)).toEqual(want);
      expect(placeholders(leaf(hi as Record<string, unknown>, key) as string)).toEqual(want);
    }
  });

  it('exposes a birth-time confidence selector for every TIME_CONFIDENCE key', () => {
    const conf = leaf(en as Record<string, unknown>, 'birth_time.confidence') as Record<string, string>;
    for (const k of ['exact', 'approximate', 'rough', 'unknown']) {
      expect(typeof conf[k]).toBe('string');
      expect(conf[k].length).toBeGreaterThan(0);
    }
  });

  it('the life-events CTA no longer claims analysis that does not happen', () => {
    expect((leaf(en as Record<string, unknown>, 'life_events.analyze_continue') as string).toLowerCase()).not.toContain('analyz');
    expect((leaf(en as Record<string, unknown>, 'life_events.analyzing') as string).toLowerCase()).not.toContain('analyz');
  });
});
