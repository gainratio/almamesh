// Build-time: key the Workbox precache on the files that set response headers.
//
// Workbox keeps a precache entry across deploys while its cache key is
// unchanged, and it keeps the response HEADERS along with the bytes. Content-
// hashed chunks have no revision, so their key is just the URL: a deploy that
// changes only `public/_headers` (e.g. #157 adding COOP/COEP) left every
// returning visitor on the old headers, and the isolated page refused its own
// chart Worker.
//
// Salting every entry's revision with a hash of the header sources makes a
// header change re-key the whole precache. Two Workbox behaviours then do the
// rest (workbox-precaching 7.4.1, PrecacheController):
//   - a revisioned entry is fetched with `cache: 'reload'`, so the fresh copy
//     comes from the server with today's headers, never from the year-long
//     immutable HTTP cache that still holds the old ones. (A new `cacheId`
//     alone would NOT do this: unrevisioned entries fetch with the default
//     cache mode and would be refilled from that HTTP cache, old headers and
//     all.)
//   - on activate, every precached request whose key is not in the new
//     manifest is deleted, so no old-header entry survives.
// Same headers => same key, so an ordinary deploy re-downloads nothing extra.
// Runtime caches (Pyodide, signed bundle, models) are separate caches and are
// never touched.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Every file that determines this site's response headers (relative to apps/web). */
export const PRECACHE_HEADER_SOURCES = ['public/_headers'] as const;

export interface HeaderSource {
  readonly path: string;
  readonly content: string;
}

interface ManifestEntry {
  readonly url: string;
  readonly revision: string | null;
}

export function readPrecacheHeaderSources(webRoot: string): HeaderSource[] {
  return PRECACHE_HEADER_SOURCES.map((file) => ({
    path: file,
    content: readFileSync(path.join(webRoot, file), 'utf8'),
  }));
}

/** sha256 of the JSON `[path, content]` list, first 16 hex characters. */
export function responseHeadersKey(sources: readonly HeaderSource[]): string {
  const canonical = JSON.stringify(sources.map((source) => [source.path, source.content]));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function keyPrecacheByResponseHeaders<E extends ManifestEntry>(entries: readonly E[], key: string): E[] {
  const salt = `headers-${key}`;
  return entries.map((entry) => ({
    ...entry,
    revision: entry.revision === null ? salt : `${entry.revision}.${salt}`,
  }));
}
