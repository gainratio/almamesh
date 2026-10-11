/** Split the reference fixture into fetchable JSON batches; never JS modules. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/web');
export const CITY_PART_ROWS = 1000;

export function writeCityParts(rows) {
  const target = resolve(webRoot, 'public/cities');
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(target)) {
    if (/^cities-part-\d+\.json$/.test(name)) rmSync(resolve(target, name));
  }
  const version = createHash('sha256');
  const partHashes = [];
  for (let start = 0; start < rows.length; start += CITY_PART_ROWS) {
    const json = JSON.stringify(rows.slice(start, start + CITY_PART_ROWS));
    version.update(json);
    partHashes.push(createHash('sha256').update(json).digest('hex'));
    writeFileSync(resolve(target, `cities-part-${String(partHashes.length - 1).padStart(2, '0')}.json`), json);
  }
  const manifest = { version: version.digest('hex'), rows: rows.length, parts: partHashes.length, partHashes };
  writeFileSync(resolve(target, 'manifest.json'), JSON.stringify(manifest) + '\n');
  // Only this small version/hash index is part of the JS module graph.
  writeFileSync(resolve(webRoot, 'src/data/cities.manifest.json'), JSON.stringify(manifest) + '\n');
  return manifest;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const rows = JSON.parse(readFileSync(resolve(webRoot, 'src/data/cities.min.json'), 'utf8'));
  const manifest = writeCityParts(rows);
  process.stdout.write(`Wrote ${manifest.rows} cities in ${manifest.parts} fetch batches (${manifest.version})\n`);
}
