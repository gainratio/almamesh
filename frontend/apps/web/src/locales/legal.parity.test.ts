import { describe, expect, it } from 'vitest';
import en from './en/legal.json';
import es from './es/legal.json';
import pt from './pt/legal.json';
import hi from './hi/legal.json';
import enCommon from './en/common.json';
import esCommon from './es/common.json';
import ptCommon from './pt/common.json';
import hiCommon from './hi/common.json';

const keys = (value: unknown, prefix = ''): string[] =>
  value && typeof value === 'object'
    ? Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
        key === '_meta' ? [] : keys(nested, prefix ? `${prefix}.${key}` : key),
      )
    : [prefix];

const LOCALES = { en, es, pt, hi } as const;

describe('legal i18n parity', () => {
  it('Spanish, Portuguese, and Hindi match the English legal catalog keys', () => {
    expect(keys(es).sort()).toEqual(keys(en).sort());
    expect(keys(pt).sort()).toEqual(keys(en).sort());
    expect(keys(hi).sort()).toEqual(keys(en).sort());
  });
});

describe('birthplace privacy disclosure', () => {
  const expectations = {
    en: { metadata: ['ordinary', 'https/request', 'metadata', 'provider'], city: 'city name' },
    es: { metadata: ['metadatos', 'normales', 'https', 'proveedor'], city: 'nombre de la ciudad' },
    pt: { metadata: ['metadados', 'normais', 'https', 'provedor'], city: 'nome da cidade' },
    hi: { metadata: ['सामान्य', 'https', 'मेटाडेटा', 'प्रदाता'], city: 'शहर का नाम' },
  } as const;

  for (const [language, legal] of Object.entries(LOCALES)) {
    it(`[${language}] names the city query and ordinary request metadata`, () => {
      const disclosure = legal.privacy.s2_li3.toLowerCase();
      const expected = expectations[language as keyof typeof expectations];

      expect(disclosure).toContain(expected.city);
      for (const term of expected.metadata) expect(disclosure).toContain(term);
      expect(disclosure).not.toMatch(
        /(?:only the city name|solo el nombre de la ciudad|apenas o nome da cidade|केवल शहर का नाम)/,
      );
    });
  }
});

describe('location hint privacy disclosure', () => {
  const commonCatalogs = {
    en: enCommon,
    es: esCommon,
    pt: ptCommon,
    hi: hiCommon,
  } as const;
  const bannedCityOnlyCopy = {
    en: 'only the city name',
    es: 'solo se envía el nombre de la ciudad',
    pt: 'apenas o nome da cidade é enviado',
    hi: 'केवल शहर का नाम',
  } as const;

  for (const [language, common] of Object.entries(commonCatalogs)) {
    it(`[${language}] does not imply that only query text leaves the device`, () => {
      const hint = common.location.offline_hint.toLowerCase();
      expect(hint).toContain('https');
      expect(hint).not.toContain(bannedCityOnlyCopy[language as keyof typeof bannedCityOnlyCopy]);
    });
  }
});
