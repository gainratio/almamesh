import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : /\.tsx?$/.test(file) ? [file] : [];
  });
}
describe('derived database library boundary', () => {
  it('only derivedDb opens the SQL runtime', () => {
    const importers = sourceFiles(root)
      .filter((file) => !/__tests__|\.test\./.test(file))
      .filter((file) => /from ['"]@gainratio\/browser\/sql['"]/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file));
    expect(importers).toEqual(['lib/derivedDb.ts']);
  });
});
