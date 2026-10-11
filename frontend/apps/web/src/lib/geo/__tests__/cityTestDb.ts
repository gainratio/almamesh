import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { openNodeSqlDatabase } from '@gainratio/browser/sql/node';
import manifest from '../../../../public/cities/manifest.json';
import { __setDerivedDbForTest, migrateDerivedDb, type SqlDatabase } from '../../derivedDb';
import { ensureCitiesImported } from '../citySql';
import type { CityRow } from '../cityMatch';

/** Exercise the production SQL implementation without browser Workers or HTTP. */
export function installCityTestDatabase(): void {
  let db: SqlDatabase;
  beforeAll(async () => {
    db = await openNodeSqlDatabase({ name: `geo-fixture-${Math.random()}` });
    await migrateDerivedDb(db);
    await ensureCitiesImported(db, async () => ({
      version: manifest.version,
      rows: manifest.rows,
      parts: Array.from({ length: manifest.parts }, (_, index) => async () => JSON.parse(
        await readFile(resolve(__dirname, '../../../../public/cities', `cities-part-${String(index).padStart(2, '0')}.json`), 'utf8'),
      ) as CityRow[]),
    }));
    __setDerivedDbForTest(db);
  });
  afterAll(async () => {
    __setDerivedDbForTest(undefined);
    await db?.close();
  });
}
