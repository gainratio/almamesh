import { describe, it, expect } from 'vitest';
import en from './en/rectify.json';
import es from './es/rectify.json';
import pt from './pt/rectify.json';
import hi from './hi/rectify.json';

const keys = (o: unknown, p = ''): string[] =>
  o && typeof o === 'object'
    ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
        k === '_meta' ? [] : keys(v, p ? `${p}.${k}` : k),
      )
    : [p];

describe('rectify i18n parity', () => {
  it('es matches en keys', () => expect(keys(es).sort()).toEqual(keys(en).sort()));
  it('pt matches en keys', () => expect(keys(pt).sort()).toEqual(keys(en).sort()));
  it('hi matches en keys', () => expect(keys(hi).sort()).toEqual(keys(en).sort()));
});
