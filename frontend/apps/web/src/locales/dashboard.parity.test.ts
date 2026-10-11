import { describe, it, expect } from 'vitest';
import en from './en/dashboard.json';
import es from './es/dashboard.json';
import pt from './pt/dashboard.json';

/** Flatten to dotted leaf keys, skipping `_meta` annotation blocks. */
const keys = (o: unknown, p = ''): string[] =>
  o && typeof o === 'object'
    ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
        k === '_meta' ? [] : keys(v, p ? `${p}.${k}` : k),
      )
    : [p];

describe('dashboard i18n parity', () => {
  it('es matches en keys', () => expect(keys(es).sort()).toEqual(keys(en).sort()));
  it('pt matches en keys', () => expect(keys(pt).sort()).toEqual(keys(en).sort()));
});

/**
 * es/pt `time_travel` values allowed to equal en, each with its reason.
 * Empty today: every Dashboard time-travel string is translated.
 */
const SAME_AS_EN: Readonly<Record<string, string>> = {};

const placeholders = (value: string): string[] => (value.match(/\{\{\s*\w+\s*\}\}/g) ?? []).sort();

describe('dashboard:time_travel keys and values', () => {
  const enBlock: Readonly<Record<string, string>> = en.time_travel;
  const locales = { es: es.time_travel, pt: pt.time_travel } as const;

  it('the en block is not empty', () => expect(Object.keys(enBlock).length).toBeGreaterThan(0));

  for (const [lang, block] of Object.entries(locales)) {
    const values: Readonly<Record<string, string>> = block;

    it(`${lang} has exactly the en keys`, () => expect(Object.keys(values).sort()).toEqual(Object.keys(enBlock).sort()));

    it(`${lang} translates every value (no copy of en outside the allowlist)`, () => {
      const copied = Object.keys(enBlock).filter((key) => values[key] === enBlock[key] && !(key in SAME_AS_EN));
      expect(copied).toEqual([]);
    });

    it(`${lang} keeps every interpolation placeholder`, () => {
      for (const key of Object.keys(enBlock)) {
        expect(placeholders(values[key] ?? ''), `${lang}.time_travel.${key}`).toEqual(placeholders(enBlock[key] ?? ''));
      }
    });
  }
});
