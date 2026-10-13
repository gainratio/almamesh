// @vitest-environment node
/**
 * Regression: main 31ce4d59, WebKit run 38352841727. The chat's resolve_place
 * started the first (cold) city import, fetched batches 00-06 of 25, and the
 * import then failed. The tool returned tool_failed, and the agent refuses an
 * identical retry in the same turn, so one transient failure in a 25-batch
 * import lost the whole "Take me to ... in Bogotá" request.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openNodeSqlDatabase } from '@gainratio/browser/sql/node';
import { __setDerivedDbForTest, migrateDerivedDb, type SqlDatabase } from '../derivedDb';
import { CityLookupError } from './cityLookup';
import { lookupPlaceOffline, placeFromRef } from './placeLookup';

const PARTS = 25;
let db: SqlDatabase | undefined;

afterEach(async () => {
  __setDerivedDbForTest(undefined);
  await db?.close();
  db = undefined;
  vi.unstubAllGlobals();
});

async function emptyDerivedDb(): Promise<void> {
  db = await openNodeSqlDatabase({ name: `geo-place-retry-${Math.random()}` });
  await migrateDerivedDb(db);
  __setDerivedDbForTest(db);
}

function servePart(url: string): Promise<Response> {
  return readFile(resolve(__dirname, '../../../public', url.replace(/^\//, '')), 'utf8').then((text) => new Response(text));
}

/** Serve the bundled batches, failing the given 1-based reads like WebKit's "Load failed". */
function stubFetch(failingReads: (read: number) => boolean): { reads: () => number } {
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    reads += 1;
    if (failingReads(reads)) throw new TypeError('Load failed');
    return servePart(url);
  }));
  return { reads: () => reads };
}

describe('resolve_place survives one failed cold import', () => {
  it('a batch failing mid-import (after 00-06, as in CI) is retried once and Bogotá is found', async () => {
    await emptyDerivedDb();
    const fetches = stubFetch((read) => read === 8);
    const result = await lookupPlaceOffline('Bogotá');
    expect(result.status).toBe('found');
    if (result.status === 'found') expect(result.place.summary.timezone).toBe('America/Bogota');
    // 7 good batches + the failed 8th read, then a clean restart of all 25.
    expect(fetches.reads()).toBe(8 + PARTS);
  });

  it('a place_ref read is retried the same way', async () => {
    await emptyDerivedDb();
    stubFetch((read) => read === 1);
    const found = await placeFromRef('city:0');
    expect(found?.summary.place_ref).toBe('city:0');
  });

  it('a failure that persists is reported once more, naming the step and carrying the cause', async () => {
    await emptyDerivedDb();
    const fetches = stubFetch(() => true);
    const failure = await lookupPlaceOffline('Bogotá').then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(CityLookupError);
    expect(failure).toMatchObject({ code: 'geo.city_import', cause: { name: 'TypeError' } });
    expect(fetches.reads()).toBe(2);
  });

  it('a cancelled lookup (page teardown) is not retried', async () => {
    await emptyDerivedDb();
    const fetches = { reads: 0 };
    vi.stubGlobal('fetch', vi.fn(async () => {
      fetches.reads += 1;
      throw new DOMException('The derived database lookup was cancelled because the page is unloading.', 'AbortError');
    }));
    await expect(lookupPlaceOffline('Bogotá')).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetches.reads).toBe(1);
  });
});
