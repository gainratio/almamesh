import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeErrorCauses,
  KNOWN_ERROR_CLASSES,
  safeCauseWarn,
  TYPED_ERROR_CAUSE_MARKER,
} from '@almamesh/shared-types';

class EngineOperationError extends Error {
  public override readonly name = 'EngineOperationError';
  public constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

class EngineBootstrapError extends Error {
  public override readonly name = 'EngineBootstrapError';
}

const SECRET = 'Invariant Ada born 1988-08-08 in Bengaluru';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('describeErrorCauses', () => {
  it('names each error in the cause chain by class and code, never by message', () => {
    const root = new EngineOperationError(`SQLITE_ERROR: sqlite3 result code 1: no such table: chunk (${SECRET})`, 'internal');
    const error = new EngineBootstrapError(`boot failed for ${SECRET}`, { cause: root });

    const summary = describeErrorCauses(error);

    expect(summary).toBe('EngineBootstrapError <- EngineOperationError(code=internal, sqlite=SQLITE_ERROR)');
    expect(summary).not.toContain('Ada');
    expect(summary).not.toContain('no such table');
  });

  it('reduces an extended SQLite code to its fixed primary name', () => {
    const error = new Error('SQLITE_IOERR_SHORT_READ: sqlite3 result code 522: disk I/O error');
    expect(describeErrorCauses(error)).toBe('Error(sqlite=SQLITE_IOERR)');
  });

  it('prints an unknown code as ? and an unknown class as Error', () => {
    const error = Object.assign(new Error('x'), { code: `bad code ${SECRET}`, name: 'has space' });
    expect(describeErrorCauses(error)).toBe('Error(code=?)');
  });

  // Assembled at run time so the secret scanner never sees a key-shaped literal.
  const KEY_SHAPED = ['sk', 'or', 'v1', `${'0123456789abcdef'.repeat(2)}0123456789abc`].join('-');

  it('builds the key-shaped code at the 54 characters northstar used', () => {
    expect(KEY_SHAPED).toHaveLength(54);
  });

  // The four inputs that leaked through the old shape-only filter (northstar, #321).
  it.each([
    ['a dotted, dated code', 'Ada.Lovelace-1988-08-08'],
    ['a 54-character key-shaped code', KEY_SHAPED],
  ])('never prints %s', (_label, code) => {
    const summary = describeErrorCauses(Object.assign(new Error('x'), { code }));
    expect(summary).toBe('Error(code=?)');
    expect(summary).not.toContain(code);
  });

  it('never prints a SQLITE_-shaped token that is not a SQLite result code', () => {
    const summary = describeErrorCauses(new Error('failed: SQLITE_BENGALURU_ADA'));
    expect(summary).toBe('Error(sqlite=?)');
    expect(summary).not.toContain('BENGALURU');
  });

  it('never prints a class name outside the known error classes', () => {
    const summary = describeErrorCauses(Object.assign(new Error('x'), { name: 'Bengaluru' }));
    expect(summary).toBe('Error');
  });

  it('drops a provider-supplied code (llm client in-band error)', () => {
    // packages/llm/src/client.ts reads `error.code` from the provider's JSON body.
    const provider = Object.assign(new Error('x'), { code: 'invalid_api_key' });
    const numeric = Object.assign(new Error('x'), { code: 429 });
    expect(describeErrorCauses(provider)).toBe('Error(code=?)');
    expect(describeErrorCauses(numeric)).toBe('Error(code=?)');
  });

  it.each([
    ['EngineOperationError', 'integrity'],
    ['EngineOperationError', 'rollback'],
    ['EngineOperationError', 'network'],
    ['EngineOperationError', 'lock'],
    ['EngineOperationError', 'storage'],
    ['ReasoningTimeoutError', 'ai.reasoning_timeout'],
    ['ChatSummaryGenerationError', 'malformed_json'],
    ['BackupCryptoError', 'bad_passphrase'],
    ['BackupError', 'too_new'],
    ['SetAsideRestoreError', 'unknown_person'],
    ['SemanticMemoryStorageUnavailableError', 'memory.opfs_unavailable'],
  ])('prints the fixed %s code %s', (name, code) => {
    const error = Object.assign(new Error('x'), { name, code });
    expect(describeErrorCauses(error)).toBe(`${name}(code=${code})`);
  });

  it('describes a non-Error cause by its type only', () => {
    const error = new Error('outer', { cause: SECRET });
    expect(describeErrorCauses(error)).toBe('Error <- string');
  });

  it('stops on a cycle and caps the depth', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    Object.assign(a, { cause: b });
    expect(describeErrorCauses(a)).toBe('Error <- Error');

    let deep: unknown = new Error('leaf');
    for (let i = 0; i < 20; i++) deep = new Error('wrap', { cause: deep });
    expect(describeErrorCauses(deep).split(' <- ')).toHaveLength(8);
  });

  it('describes a missing error as none', () => {
    expect(describeErrorCauses(undefined)).toBe('none');
  });
});

describe('safeCauseWarn', () => {
  it('warns one marked line with the summary', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    safeCauseWarn(new EngineOperationError(SECRET, 'storage'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(`[${TYPED_ERROR_CAUSE_MARKER}] EngineOperationError(code=storage)`);
  });

  it('pins the marker the production-build check greps for', () => {
    expect(TYPED_ERROR_CAUSE_MARKER).toBe('almamesh:diag:typed_error_cause');
  });
});

/** Every `class FooError` declared in `dir` (test files and fakes excluded). */
function declaredErrorClasses(dir: string, sourceOnly: boolean): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'dist' && sourceOnly) continue;
    if (statSync(path).isDirectory()) {
      found.push(...declaredErrorClasses(path, sourceOnly));
    } else if (/\.(ts|tsx|js)$/.test(name) && !/\.(test|spec)\.|\.d\.ts$|__tests__|\/test\//.test(path)) {
      for (const match of readFileSync(path, 'utf8').matchAll(/\bclass ([A-Z][A-Za-z0-9]*Error)\b/g)) {
        found.push(match[1] as string);
      }
    }
  }
  return found;
}

describe('KNOWN_ERROR_CLASSES', () => {
  it('lists every error class AlmaMesh and @gainratio/browser declare', () => {
    const frontend = resolve(import.meta.dirname, '../../../..');
    const roots = ['apps/web/src', 'packages/browser/src', 'packages/llm/src', 'packages/memory/src', 'packages/store/src'];
    const library = dirname(
      createRequire(join(frontend, 'packages/browser/package.json')).resolve('@gainratio/browser/package.json'),
    );
    const declared = new Set([
      ...roots.flatMap((root) => declaredErrorClasses(join(frontend, root), true)),
      ...declaredErrorClasses(join(library, 'dist'), false),
    ]);
    const missing = [...declared].filter((name) => !KNOWN_ERROR_CLASSES.has(name)).sort();
    expect(missing).toEqual([]);
  });
});
