import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../..');
const PLACE_PATH_FILES = ['lib/placeTool.ts', 'lib/geo/placeLookup.ts', 'lib/timingTool.ts', 'lib/chatToolset.ts', 'lib/moonWindow.ts', 'lib/timingPlaces.ts'];
/** Files in every tier's chat chunk: they must not pull tz-lookup or the online geocoder in by a static import. */
const CHAT_CHUNK_FILES = ['lib/chatToolset.ts', 'lib/placeTool.ts', 'lib/timingTool.ts', 'lib/timingPlaces.ts', 'lib/chatAgentTools.ts'];
const STATIC_GEO_IMPORT = /^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s+['"][./]*(?:geo\/)?(?:placeLookup|cityLookup)['"]/m;

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

  it.each(CHAT_CHUNK_FILES)('%s loads the geo module only by a dynamic import (final review ruling)', (file) => {
    const text = readFileSync(join(SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
    expect(text).not.toMatch(STATIC_GEO_IMPORT);
  });

  it('the static-import check catches a value import and ignores a type-only one', () => {
    expect("import { placeFromRef } from './geo/placeLookup';").toMatch(STATIC_GEO_IMPORT);
    expect("import {\n  searchCitiesOffline,\n} from './geo/cityLookup';").toMatch(STATIC_GEO_IMPORT);
    expect("export { placeFromRef } from './geo/placeLookup';").toMatch(STATIC_GEO_IMPORT);
    expect("import type { ResolvedPlace } from './geo/placeLookup';").not.toMatch(STATIC_GEO_IMPORT);
    expect("(ref) => import('./geo/placeLookup').then((m) => m.placeFromRef(ref))").not.toMatch(STATIC_GEO_IMPORT);
  });

  it('the city list is only ever loaded by a dynamic import', () => {
    const statics = sourceFiles(SRC).filter((path) => /^\s*import[^(]*cities\.min\.json/m.test(readFileSync(path, 'utf8')));
    expect(statics).toEqual([]);
    expect(readFileSync(join(SRC, 'lib/geo/cityLookup.ts'), 'utf8')).toContain("import('../../data/cities.min.json')");
  });
});
