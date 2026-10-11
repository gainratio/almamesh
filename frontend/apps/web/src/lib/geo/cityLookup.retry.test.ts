// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openNodeSqlDatabase } from '@gainratio/browser/sql/node';
import { __setDerivedDbForTest, migrateDerivedDb, type SqlDatabase } from '../derivedDb';
import { searchCityRowsOffline } from './cityLookup';

let db: SqlDatabase | undefined;
afterEach(async () => {
  __setDerivedDbForTest(undefined);
  await db?.close();
  db = undefined;
  vi.unstubAllGlobals();
});

describe('city batch load failure', () => {
  it('is not cached: a later lookup retries the import and succeeds', async () => {
    db = await openNodeSqlDatabase({ name: 'geo-retry' });
    await migrateDerivedDb(db);
    __setDerivedDbForTest(db);
    let reads = 0;
    const fetchMock = vi.fn(async (url: string) => {
      reads += 1;
      if (reads === 1) throw new Error('chunk fetch failed');
      return new Response(await readFile(resolve(__dirname, '../../../public', url.replace(/^\//, '')), 'utf8'));
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(searchCityRowsOffline('Bogota')).rejects.toThrow('chunk fetch failed');
    const rows = await searchCityRowsOffline('Bogota');
    expect(rows[0]?.match.city).toBe('Bogotá');
    expect(fetchMock).toHaveBeenCalledTimes(26);
  });
});
