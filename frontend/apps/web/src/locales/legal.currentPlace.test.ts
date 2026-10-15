import { describe, expect, it } from 'vitest';
import en from './en/legal.json';
import es from './es/legal.json';
import pt from './pt/legal.json';

/** "Where do you live now?" is disclosed as user-entered data that stays in this browser. */
const DISCLOSURE = {
  en: ['where you live now if you add it in Profile settings', 'all stored only in this browser'],
  es: ['dónde vives ahora si lo añades en Perfil', 'todo almacenado únicamente en este navegador'],
  pt: ['onde você mora agora se você adicionar em Perfil', 'tudo armazenado apenas neste navegador'],
};

describe('current place privacy disclosure', () => {
  it.each([['en', en], ['es', es], ['pt', pt]] as const)('%s lists where you live now as on-device data', (language, catalog) => {
    for (const phrase of DISCLOSURE[language]) expect(catalog.privacy.s1_sub1_li2_text).toContain(phrase);
  });
});
