import { describe, it, expect } from 'vitest';
import en from './en/feedback.json';
import es from './es/feedback.json';
import pt from './pt/feedback.json';
import hi from './hi/feedback.json';

/** Flatten to dotted leaf keys, skipping `_meta` annotation blocks. */
const keys = (o: unknown, p = ''): string[] =>
  o && typeof o === 'object'
    ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
        k === '_meta' ? [] : keys(v, p ? `${p}.${k}` : k),
      )
    : [p];

/** Leaf paths whose string value is empty/whitespace (a missing translation). */
const emptyLeaves = (o: unknown, p = ''): string[] => {
  if (typeof o === 'string') return o.trim().length === 0 ? [p] : [];
  if (o && typeof o === 'object') {
    return Object.entries(o as Record<string, unknown>)
      .filter(([k]) => k !== '_meta')
      .flatMap(([k, v]) => emptyLeaves(v, p ? `${p}.${k}` : k));
  }
  return [p];
};

describe('feedback i18n parity', () => {
  it('es matches en keys', () => expect(keys(es).sort()).toEqual(keys(en).sort()));
  it('pt matches en keys', () => expect(keys(pt).sort()).toEqual(keys(en).sort()));
  it('hi matches en keys', () => expect(keys(hi).sort()).toEqual(keys(en).sort()));

  it('every leaf is a non-empty string in all four catalogs', () => {
    expect(emptyLeaves(en)).toEqual([]);
    expect(emptyLeaves(es)).toEqual([]);
    expect(emptyLeaves(pt)).toEqual([]);
    expect(emptyLeaves(hi)).toEqual([]);
  });
});
