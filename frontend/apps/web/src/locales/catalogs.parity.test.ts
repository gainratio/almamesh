import { describe, expect, it } from 'vitest';
import { I18N_NAMESPACES } from '../i18n/config';

const CATALOGS = import.meta.glob<{ default: Record<string, unknown> }>(
  './{en,es,pt,hi}/*.json',
  { eager: true },
);

const leaves = (value: unknown, prefix = ''): (readonly [string, unknown])[] =>
  value && typeof value === 'object'
    ? Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
        k === '_meta' ? [] : leaves(v, prefix ? `${prefix}.${k}` : k),
      )
    : [[prefix, value] as const];

const placeholders = (ns: string, key: string, value: unknown): string =>
  (typeof value === 'string' ? (value.match(/\{\{\s*\w+\s*\}\}/g) ?? []) : [])
    .map((m) => {
      const token = m.replace(/\s/g, '');
      // localizeSignal() passes both `house` and `houseOrdinal`; non-English locales use `{{house}}`.
      return ns === 'rectify' && key.startsWith('signals.') && token === '{{houseOrdinal}}'
        ? '{{house}}'
        : token;
    })
    .sort()
    .join(',');

describe('all 15 i18n namespaces — key and placeholder parity across en/es/pt/hi', () => {
  it.each(I18N_NAMESPACES)('%s has identical keys and {{placeholders}} in es, pt, and hi', (ns) => {
    const enMod = CATALOGS[`./en/${ns}.json`]?.default;
    expect(enMod, `missing ./en/${ns}.json`).toBeDefined();
    const enMap = new Map(leaves(enMod));
    const enKeys = [...enMap.keys()].sort();

    for (const lang of ['es', 'pt', 'hi'] as const) {
      const mod = CATALOGS[`./${lang}/${ns}.json`]?.default;
      expect(mod, `missing ./${lang}/${ns}.json`).toBeDefined();
      const langLeaves = leaves(mod);
      expect(langLeaves.map(([k]) => k).sort(), `${lang}/${ns}.json keys`).toEqual(enKeys);
      const drift = langLeaves
        .filter(([k, v]) => placeholders(ns, k, v) !== placeholders(ns, k, enMap.get(k)))
        .map(([k]) => k);
      expect(drift, `${lang}/${ns}.json placeholder drift`).toEqual([]);
    }
  });
});
