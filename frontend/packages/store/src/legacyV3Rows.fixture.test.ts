/**
 * `legacy-v3-canonical-rows.json` is the chart-library and profiles rows of the
 * real `legacy-v3.almamesh` export, verbatim. Tests that need the oldest chart
 * shape without a SQLite reader (CI's Node has no `node:sqlite`) read it.
 *
 * This test ties the extract to the export: wherever Node ships `node:sqlite`
 * (22.5+) it opens the export, reads the rows, and requires byte equality.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultSealRunner, openBackup } from './backupSealing';

const FIXTURES = new URL('./__fixtures__/legacy-backups/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', FIXTURES), 'utf8')) as Record<
  string,
  { passphrase: string }
>;
const extract = JSON.parse(
  readFileSync(new URL('legacy-v3-canonical-rows.json', FIXTURES), 'utf8'),
) as { rows: Record<string, string> };

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string, options: { readOnly: boolean }) => SqliteDatabase;
}

// Looked up at runtime, never imported: bundlers and older Node reject the specifier.
const sqlite = process.getBuiltinModule?.('node:sqlite') as SqliteModule | undefined;

function readRows(database: Uint8Array, keys: readonly string[]): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'almamesh-legacy-v3-'));
  try {
    const file = join(dir, 'legacy.sqlite');
    writeFileSync(file, database);
    const db = new sqlite!.DatabaseSync(file, { readOnly: true });
    const rows = db
      .prepare(
        "SELECT key, CAST(value AS TEXT) AS value FROM edgeproc_state_rows WHERE namespace = 'canonical' AND key IN (?, ?)",
      )
      .all(...keys) as Array<{ key: string; value: string }>;
    db.close();
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('legacy-v3 canonical rows extract', () => {
  it('holds the oldest chart shape: no snapshot, no calculation instant', () => {
    const library = JSON.parse(extract.rows['almamesh-chart-library']!) as {
      state: { charts: Record<string, { astronomical_calculations: Record<string, unknown> }> };
    };
    const chart = library.state.charts['portable-chart-ada']!;
    expect(chart.astronomical_calculations).not.toHaveProperty('snapshot');
    expect(chart.astronomical_calculations).not.toHaveProperty('calculation_timestamp');
  });

  it.skipIf(sqlite === undefined)(
    'is byte-identical to the rows inside the real export',
    async () => {
      const bytes = new Uint8Array(readFileSync(new URL('legacy-v3.almamesh', FIXTURES)));
      const opened = await openBackup(
        bytes,
        manifest['legacy-v3.almamesh']!.passphrase,
        defaultSealRunner(),
      );
      if (opened.kind !== 'database') throw new Error('expected a SQLite export');
      expect(readRows(opened.database, Object.keys(extract.rows))).toEqual(extract.rows);
    },
    60_000,
  );
});
