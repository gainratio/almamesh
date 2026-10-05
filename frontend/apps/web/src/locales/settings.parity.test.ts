import { describe, it, expect } from 'vitest';
import en from './en/settings.json';
import es from './es/settings.json';
import pt from './pt/settings.json';

const keys = (o: unknown, p = ''): string[] =>
  o && typeof o === 'object'
    ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
        k === '_meta' ? [] : keys(v, p ? `${p}.${k}` : k),
      )
    : [p];

describe('settings i18n parity', () => {
  it('es matches en keys', () => expect(keys(es).sort()).toEqual(keys(en).sort()));
  it('pt matches en keys', () => expect(keys(pt).sort()).toEqual(keys(en).sort()));
});

// Dead copy is a stale promise: the backup namespace describes what Import and
// Export do, so a string no source file references describes behavior that no
// longer exists (`error_safety_cancelled` outlived the reversed safety-copy
// contract). Every backup key must be referenced as `backup.<key>`.
describe('settings backup copy is all in use', () => {
  it('every en backup key is referenced from source', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const sources: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== '__tests__' && name !== 'locales') walk(path);
        } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          sources.push(readFileSync(path, 'utf8'));
        }
      }
    };
    walk(join(__dirname, '..'));
    const corpus = sources.join('\n');
    const backup = (en as { backup: Record<string, unknown> }).backup;
    // i18next plural forms (`_one`, `_other`) are referenced by their base key.
    const base = (key: string) => key.replace(/_(zero|one|two|few|many|other)$/, "");
    const unused = keys(backup).filter((key) => !corpus.includes(`backup.${base(key)}`));
    expect(unused).toEqual([]);
  });
});
