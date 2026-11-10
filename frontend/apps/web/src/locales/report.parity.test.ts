import { describe, it, expect } from 'vitest';
import en from './en/report.json';
import es from './es/report.json';
import pt from './pt/report.json';
import hi from './hi/report.json';

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

describe('report i18n parity', () => {
  it('es matches en keys', () => expect(keys(es).sort()).toEqual(keys(en).sort()));
  it('pt matches en keys', () => expect(keys(pt).sort()).toEqual(keys(en).sort()));
  it('hi matches en keys', () => expect(keys(hi).sort()).toEqual(keys(en).sort()));

  it('es/pt/hi cover templates carry the same {{placeholders}} as en', () => {
    for (const key of keys(en).filter((k) => k.startsWith('cover.'))) {
      const enVal = leaf(en as Record<string, unknown>, key);
      if (typeof enVal !== 'string') continue;
      const want = placeholders(enVal);
      expect(placeholders(leaf(es as Record<string, unknown>, key) as string)).toEqual(want);
      expect(placeholders(leaf(pt as Record<string, unknown>, key) as string)).toEqual(want);
      expect(placeholders(leaf(hi as Record<string, unknown>, key) as string)).toEqual(want);
    }
  });
});
