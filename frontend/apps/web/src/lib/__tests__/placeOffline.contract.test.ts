import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../..');
// Task 6 adds lib/moonWindow.ts to this list.
const PLACE_PATH_FILES = ['lib/placeTool.ts', 'lib/geo/placeLookup.ts', 'lib/timingTool.ts', 'lib/chatToolset.ts'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('a chat-typed city never leaves the device', () => {
  it.each(PLACE_PATH_FILES)('%s never imports the online geocoder or searchCities', (file) => {
    const text = readFileSync(join(SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(text).not.toMatch(/onlineGeocoder|geocodeCitiesOnline|\bsearchCities\b/);
  });

  it('the city list is only ever loaded by a dynamic import', () => {
    const statics = sourceFiles(SRC).filter((path) => /^\s*import[^(]*cities\.min\.json/m.test(readFileSync(path, 'utf8')));
    expect(statics).toEqual([]);
    expect(readFileSync(join(SRC, 'lib/geo/cityLookup.ts'), 'utf8')).toContain("import('../../data/cities.min.json')");
  });
});
