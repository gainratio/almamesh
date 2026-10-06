/**
 * Guard: SQLite is the ONLY store for app data. No non-test source may write
 * app data to localStorage or IndexedDB — not as a system of record, a
 * fallback, or a mirror. Reading or removing legacy values (one-time
 * migrations, reset cleanup) is allowed. The single allowed browser-storage
 * write is a sessionStorage reload flag in the self-heal files listed below.
 *
 * The check walks the TypeScript AST (not regexes), so quoting, aliases,
 * element access, namespace and dynamic imports cannot slip past it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
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

/**
 * The one allowed IndexedDB open: the legacy keyval EXISTENCE probe. It opens
 * with no version and aborts the upgrade when the database does not exist, so
 * nothing is created (legacyKeyval.test.ts proves it, red without the abort).
 * Needed only on browsers that cannot list databases (Firefox < 126).
 */
const IDB_OPEN_AND_ABORT_PROBE_FILES = new Set(['packages/store/src/legacyKeyval.ts']);

const IDB_KEYVAL_WRITERS = new Set(['set', 'setMany', 'update']);
const STORAGE_GLOBALS = { localStorage: 'local', sessionStorage: 'session', indexedDB: 'idb' } as const;
type StorageKind = (typeof STORAGE_GLOBALS)[keyof typeof STORAGE_GLOBALS];

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

function memberName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return undefined;
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Collects every browser-storage write in one source file. */
function storageWriteFindings(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const aliases = new Map<string, StorageKind>();
  const findings: string[] = [];

  const kindOf = (expression: ts.Expression): StorageKind | undefined => {
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) {
      return (STORAGE_GLOBALS as Record<string, StorageKind>)[node.text] ?? aliases.get(node.text);
    }
    const name = memberName(node);
    if (name !== undefined && name in STORAGE_GLOBALS) {
      return STORAGE_GLOBALS[name as keyof typeof STORAGE_GLOBALS];
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === 'browserLocalStorage') return 'local';
    }
    return undefined;
  };
  const writeOn = (kind: StorageKind, what: string): void => {
    if (kind === 'session' && SESSION_RELOAD_FLAG_FILES.has(file)) return;
    if (kind === 'idb' && what === 'open' && IDB_OPEN_AND_ABORT_PROBE_FILES.has(file)) return;
    findings.push(`${kind}: ${what}`);
  };

  // Pass 1: names bound to a storage object (`const s = localStorage`).
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined && ts.isIdentifier(node.name)) {
      const kind = kindOf(node.initializer);
      if (kind !== undefined) aliases.set(node.name.text, kind);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const from = node.moduleSpecifier;
      if (from !== undefined && ts.isStringLiteral(from) && from.text === 'idb-keyval') {
        const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
        const bindings = clause?.namedBindings;
        if (ts.isExportDeclaration(node)) findings.push('idb-keyval re-export');
        else if (clause?.name !== undefined) findings.push('idb-keyval default import');
        else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          findings.push('idb-keyval namespace import');
        } else if (bindings !== undefined) {
          for (const element of bindings.elements) {
            const imported = (element.propertyName ?? element.name).text;
            if (IDB_KEYVAL_WRITERS.has(imported)) findings.push(`idb-keyval ${imported}`);
          }
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const target = node.arguments[0];
      const dynamic =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === 'require');
      if (dynamic && target !== undefined && ts.isStringLiteralLike(target) && target.text === 'idb-keyval') {
        findings.push('idb-keyval dynamic import');
      }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = memberName(node);
      const kind = kindOf(node.expression);
      const inTypeof = ts.isTypeOfExpression(node.parent);
      if (kind !== undefined && !inTypeof) {
        if ((kind === 'local' || kind === 'session') && (name === 'setItem' || name === undefined)) {
          writeOn(kind, name === undefined ? 'computed member access' : 'setItem');
        }
        if (kind === 'idb' && name === 'open') writeOn(kind, 'open');
      }
      if (name === 'prototype' && ts.isIdentifier(node.expression) && node.expression.text === 'Storage') {
        findings.push('Storage.prototype');
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      const kind = kindOf(node.initializer);
      if (kind !== undefined) {
        for (const element of node.name.elements) {
          const key = (element.propertyName ?? element.name).getText(source);
          if (key === 'setItem' || key === 'open') writeOn(kind, `destructured ${key}`);
        }
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
    ) {
      const kind = kindOf(node.left.expression);
      if (kind === 'local' || kind === 'session') writeOn(kind, 'property assignment');
    }
    if (ts.isStringLiteralLike(node) && node.text === 'readwrite') {
      findings.push('IndexedDB readwrite transaction');
    }
    if (
      ts.isTypeReferenceNode(node) &&
      node.typeName.getText(source) === 'Pick' &&
      node.typeArguments?.[0]?.getText(source) === 'Storage' &&
      /['"]setItem['"]/.test(node.typeArguments[1]?.getText(source) ?? '')
    ) {
      findings.push('writable Storage type');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
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

  // Every shape the northstar review planted, plus a few more. Each must be caught.
  const PLANTED = [
    "localStorage.setItem('k', 'v');",
    "window.localStorage.setItem('k', 'v');",
    "globalThis.localStorage?.setItem('k', 'v');",
    "localStorage['setItem']('k', 'v');",
    "const store = localStorage; store.setItem('k', 'v');",
    "const ls = window['localStorage']; ls.setItem('k', 'v');",
    "const { setItem } = localStorage; setItem('k', 'v');",
    "const { setItem: put } = window.localStorage; put('k', 'v');",
    "browserLocalStorage()?.setItem('k', 'v');",
    "Storage.prototype.setItem.call(localStorage, 'k', 'v');",
    "localStorage.k = 'v';",
    "localStorage['k'] = 'v';",
    "sessionStorage.setItem('k', '1');",
    'import { set } from "idb-keyval";',
    "import { set as put } from 'idb-keyval';",
    "import { update } from 'idb-keyval';",
    "import * as idb from 'idb-keyval'; idb.set('k', 'v');",
    "const idb = await import('idb-keyval'); await idb.set('k', 'v');",
    "const idb = require('idb-keyval');",
    "export { set } from 'idb-keyval';",
    "indexedDB.open('db');",
    "window.indexedDB.open('db');",
    "const db = indexedDB; db.open('x');",
    "db.transaction('store', \"readwrite\");",
    "function f(s: Pick<Storage, 'getItem' | 'setItem'>) {}",
  ];

  it.each(PLANTED)('catches a planted write: %s', (shape) => {
    expect(storageWriteFindings('packages/store/src/planted.ts', shape)).not.toEqual([]);
  });

  it.each([
    ["apps/web/src/lib/swSelfHeal.ts", "sessionStorage.setItem('k', '1');"],
    ['packages/store/src/x.ts', "import { get, del, createStore } from 'idb-keyval';"],
    ['packages/store/src/x.ts', "localStorage.getItem('k'); localStorage.removeItem('k');"],
    ['packages/store/src/x.ts', "if (typeof localStorage.setItem === 'function') {}"],
    ['packages/store/src/x.ts', "indexedDB.deleteDatabase('db'); void indexedDB.databases();"],
    ['packages/store/src/x.ts', "portablePreferenceStorage.setItem('k', 'v');"],
  ])('allows reads, retirement and non-browser storage: %s %s', (file, shape) => {
    expect(storageWriteFindings(file, shape)).toEqual([]);
  });

  it('exempts only the legacy open-and-abort probe, and only its open', () => {
    const open = "const factory = globalThis.indexedDB; factory.open('keyval-store');";
    expect(storageWriteFindings('packages/store/src/legacyKeyval.ts', open)).toEqual([]);
    expect(storageWriteFindings('packages/store/src/other.ts', open)).toEqual(['idb: open']);
    expect(
      storageWriteFindings('packages/store/src/legacyKeyval.ts', "localStorage.setItem('k', 'v');"),
    ).not.toEqual([]);
    expect(
      storageWriteFindings('packages/store/src/legacyKeyval.ts', "db.transaction('s', 'readwrite');"),
    ).not.toEqual([]);
  });
});
