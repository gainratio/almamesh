import { describe, it, expect } from 'vitest';
import en from './en/chat.json';
import es from './es/chat.json';
import pt from './pt/chat.json';

const keys = (o: unknown, p = ''): string[] =>
  o && typeof o === 'object'
    ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
        k === '_meta' ? [] : keys(v, p ? `${p}.${k}` : k),
      )
    : [p];

const leaves = (o: unknown, p = ''): (readonly [string, unknown])[] =>
  o && typeof o === 'object'
    ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
        k === '_meta' ? [] : leaves(v, p ? `${p}.${k}` : k),
      )
    : [[p, o] as const];

const placeholders = (value: unknown): string =>
  (typeof value === 'string' ? (value.match(/\{\{\s*\w+\s*\}\}/g) ?? []) : [])
    .map((m) => m.replace(/\s/g, ''))
    .sort()
    .join(',');

describe('chat i18n parity', () => {
  it('es matches en keys', () => expect(keys(es).sort()).toEqual(keys(en).sort()));
  it('pt matches en keys', () => expect(keys(pt).sort()).toEqual(keys(en).sort()));

  // The coded-error keys the chat + reading surfaces render must exist in EVERY
  // language, or an offline non-English user hits a raw i18n key on a 401/429/5xx.
  it('carries every coded AI-error key in all three languages', () => {
    for (const catalog of [en, es, pt]) {
      for (const key of [
        'insufficient_credits',
        'auth_failed',
        'model_unavailable',
        'rate_limited',
        'server_error',
        'endpoint_unreachable',
        'request_failed',
        'privacy_blocked',
        'privacy_blocked_no_endpoint',
      ]) {
        expect(catalog.errors, `missing chat:errors.${key}`).toHaveProperty(key);
      }
    }
  });

  // A translation that drops a {{placeholder}} loses the detail it names (the
  // refused endpoint, for one); a renamed one renders as a literal "{{x}}".
  it.each([
    ['es', es],
    ['pt', pt],
  ] as const)('%s keeps every en {{placeholder}}', (_lang, catalog) => {
    const enValues = new Map(leaves(en));
    const drift = leaves(catalog)
      .filter(([key, value]) => placeholders(value) !== placeholders(enValues.get(key)))
      .map(([key]) => key);
    expect(drift).toEqual([]);
  });
});
