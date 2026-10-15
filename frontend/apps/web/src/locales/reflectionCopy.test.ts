import { predictionClaims, type ReflectionLanguage } from '@almamesh/llm/reflection';
import { describe, expect, it } from 'vitest';

/**
 * Reflection, not prediction (product decision 2026-10-15). A retrodiction eval on
 * licensed Astro-Databank events found no lift over chance, so no copy the app
 * ships may claim or imply prediction or predictive accuracy ("predict",
 * "forecast", "accurate", "likely", "will happen", "what happened", and their
 * es/pt equivalents). Readings are "what your chart highlights", for reflection.
 * Every catalog file is globbed, so a new namespace is covered the day it lands.
 */
const CATALOGS = import.meta.glob<{ default: unknown }>('./{en,es,pt}/*.json', { eager: true });

interface CopyLine {
  readonly file: string;
  readonly key: string;
  readonly text: string;
}

function linesOf(value: unknown, file: string, key = ''): CopyLine[] {
  if (typeof value === 'string') return [{ file, key, text: value }];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([child, inner]) => linesOf(inner, file, key ? `${key}.${child}` : child));
}

function catalogLines(language: ReflectionLanguage): CopyLine[] {
  return Object.entries(CATALOGS)
    .filter(([path]) => path.startsWith(`./${language}/`))
    .flatMap(([path, module]) => linesOf(module.default, path));
}

const LANGUAGES: readonly ReflectionLanguage[] = ['en', 'es', 'pt'];

describe('locale copy frames readings as reflection, not prediction', () => {
  it('reads every catalog file of every language', () => {
    const counts = LANGUAGES.map((language) => new Set(catalogLines(language).map((line) => line.file)).size);
    expect(counts[0]).toBeGreaterThanOrEqual(15);
    expect(new Set(counts).size).toBe(1);
  });

  it.each(LANGUAGES)('%s copy makes no prediction or accuracy claim', (language) => {
    const claims = catalogLines(language)
      .map((line) => ({ ...line, found: predictionClaims(line.text, language) }))
      .filter((line) => line.found.length > 0)
      .map((line) => `${line.file} ${line.key}: ${line.found.join(', ')}`);
    expect(claims).toEqual([]);
  });
});
