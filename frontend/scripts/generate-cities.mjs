/**
 * generate-cities.mjs — build the bundled offline city database.
 *
 * AlmaMesh is local-first / no-egress: birth-location entry must resolve to
 * { latitude, longitude } with ZERO network calls. This script pre-bakes a
 * pruned, browser-ready city list from `all-the-cities` (GeoNames, cities with
 * population >= 1000) into a static JSON asset that the LocationSearch component
 * lazy-loads. IANA timezone is derived at runtime from lat/lon via `tz-lookup`.
 *
 * We keep only cities with population > MIN_POPULATION to bound the bundle size
 * (full set is ~135k cities / ~6.4 MB; the pruned set is ~24k cities / ~2 MB raw,
 * ~0.56 MB gzipped). Country ISO2 codes are resolved to display names via
 * `countries-list`.
 *
 * Run: `bun run --filter @almamesh/web data:cities`  (regenerates the JSON)
 *
 * State / province names come from GeoNames' own admin1 table
 * (`scripts/data/geonames-admin1CodesASCII.txt`, CC BY 4.0, downloaded from
 * https://download.geonames.org/export/dump/admin1CodesASCII.txt), joined on
 * the row's `country.adminCode`, so "Novato" reads "Novato, California, United
 * States" and "Novato, CA" can be told from "Novator, Russia" on the device.
 *
 * Output shape (compact keys to shrink the payload):
 *   { n: name, s?: admin1 name, c: countryName, cc: ISO2, lat, lon, p: population }
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { writeCityParts } from './split-cities.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '../apps/web');

// Resolve build-time deps from the web app's node_modules (bun hoists workspace
// devDependencies there, not to the monorepo root).
const require = createRequire(resolve(webRoot, 'package.json'));
const cities = require('all-the-cities');
const { countries } = require('countries-list');

const MIN_POPULATION = 15000;

/** "US.CA" -> "California", from GeoNames admin1CodesASCII (code, name, ascii name, geonameid). */
function readAdmin1Names() {
  const text = readFileSync(resolve(here, 'data/geonames-admin1CodesASCII.txt'), 'utf8');
  const names = new Map();
  for (const line of text.split('\n')) {
    const [code, name] = line.split('\t');
    if (code && name) names.set(code, name);
  }
  return names;
}
const admin1Names = readAdmin1Names();

const outPath = resolve(webRoot, 'src/data/cities.min.json');

const rows = cities
  .filter((city) => city.population > MIN_POPULATION)
  .map((city) => ({
    n: city.name,
    ...(admin1Names.has(`${city.country}.${city.adminCode}`) ? { s: admin1Names.get(`${city.country}.${city.adminCode}`) } : {}),
    c: countries[city.country]?.name ?? city.country,
    cc: city.country,
    lat: city.loc.coordinates[1],
    lon: city.loc.coordinates[0],
    p: city.population,
  }))
  .sort((a, b) => b.p - a.p);

const json = JSON.stringify(rows);
// This fixture is for reproducible regeneration and test/reference consumers.
// Production fetches the bounded public JSON parts instead of importing it.
writeFileSync(outPath, json);
writeCityParts(rows);

const gzipped = gzipSync(Buffer.from(json)).length;
const fmt = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
process.stdout.write(
  `Wrote ${rows.length} cities (pop > ${MIN_POPULATION}) to ${outPath}\n` +
    `  raw: ${fmt(json.length)}  gzipped: ${fmt(gzipped)}\n`,
);
