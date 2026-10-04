/**
 * Guard: SQLite is the ONLY store for app data. No non-test source may write
 * app data to localStorage or IndexedDB — not as a system of record, a
 * fallback, or a mirror. Reading or removing legacy values (one-time
 * migrations) is allowed. The single allowed browser-storage write is a
 * sessionStorage reload flag in the self-heal paths listed below.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const FRONTEND = resolve(import.meta.dirname, '../../../../..');
const SOURCE_ROOTS = [
  join(FRONTEND, 'apps/web/src'),
  ...readdirSync(join(FRONTEND, 'packages')).map((name) => join(FRONTEND, 'packages', name, 'src')),
];

/** sessionStorage reload flags (loop guards for self-heal reloads). Nothing else. */
const SESSION_RELOAD_FLAG_FILES = new Set([
  'apps/web/src/components/ErrorBoundary.tsx',
  'apps/web/src/lib/lazyWithRetry.tsx',
  'apps/web/src/lib/swSelfHeal.ts',
]);

const IDB_KEYVAL_WRITERS = new Set(['set', 'setMany', 'update']);

function isTestSource(path: string): boolean {
  return (
    /\.(test|spec)\.tsx?$/.test(path) ||
    /\.testkit\.ts$/.test(path) ||
    path.includes('/__tests__/') ||
    path.includes('/apps/web/src/test/')
  );
}

function sourceFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !name.endsWith('.d.ts') && !isTestSource(path) ? [path] : [];
  });
}

/** Every browser-storage write in one file's text, as human-readable findings. */
function storageWriteFindings(file: string, text: string): string[] {
  const findings: string[] = [];
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  if (/\blocalStorage\b\s*\??\.\s*setItem\s*\(/.test(code)) findings.push('localStorage.setItem');
  if (/\bbrowserLocalStorage\(\)\s*\??\.\s*setItem\s*\(/.test(code)) {
    findings.push('browserLocalStorage().setItem');
  }
  if (/Pick<\s*Storage\s*,[^>]*'setItem'/.test(code)) findings.push('writable Storage type');
  if (/\bsessionStorage\b\s*\??\.\s*setItem\s*\(/.test(code) && !SESSION_RELOAD_FLAG_FILES.has(file)) {
    findings.push('sessionStorage.setItem outside the reload-flag allow-list');
  }
  if (/\bindexedDB\s*\??\.\s*open\s*\(/.test(code)) findings.push('indexedDB.open');
  if (/['"]readwrite['"]/.test(code)) findings.push('IndexedDB readwrite transaction');
  for (const match of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*'idb-keyval'/g)) {
    for (const spec of match[1]!.split(',')) {
      const imported = spec.trim().split(/\s+as\s+/)[0]!.replace(/^type\s+/, '');
      if (IDB_KEYVAL_WRITERS.has(imported)) findings.push(`idb-keyval ${imported}`);
    }
  }
  return findings;
}

describe('SQLite is the only store for app data', () => {
  it('no non-test source writes app data to localStorage or IndexedDB', () => {
    const files = SOURCE_ROOTS.flatMap(sourceFiles);
    // Sanity: the scan really covers the store package and the app.
    expect(files.some((f) => f.endsWith('packages/store/src/interpretation.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('apps/web/src/lib/resetEverything.ts'))).toBe(true);

    const violations = files.flatMap((path) => {
      const file = relative(FRONTEND, path);
      return storageWriteFindings(file, readFileSync(path, 'utf8')).map((f) => `${file}: ${f}`);
    });
    expect(violations).toEqual([]);
  });

  it('flags each forbidden write shape (the guard can fail)', () => {
    const shapes = [
      "localStorage.setItem('k', 'v');",
      "browserLocalStorage()?.setItem('k', 'v');",
      "function f(s: Pick<Storage, 'getItem' | 'setItem'>) {}",
      "sessionStorage.setItem('k', '1');",
      "indexedDB.open('db');",
      "db.transaction('store', 'readwrite');",
      "import { get, set as idbSet } from 'idb-keyval';",
      "import { update } from 'idb-keyval';",
    ];
    for (const shape of shapes) {
      expect(storageWriteFindings('packages/store/src/x.ts', shape)).not.toEqual([]);
    }
    expect(
      storageWriteFindings('apps/web/src/lib/swSelfHeal.ts', "sessionStorage.setItem('k', '1');"),
    ).toEqual([]);
    expect(
      storageWriteFindings('packages/store/src/x.ts', "import { get, del } from 'idb-keyval';"),
    ).toEqual([]);
  });
});
