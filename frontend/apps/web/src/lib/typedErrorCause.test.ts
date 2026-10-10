import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeErrorCauses, safeCauseWarn, TYPED_ERROR_CAUSE_MARKER } from '@almamesh/shared-types';

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

  it('keeps the extended SQLite result code name', () => {
    const error = new Error('SQLITE_IOERR_SHORT_READ: sqlite3 result code 522: disk I/O error');
    expect(describeErrorCauses(error)).toBe('Error(sqlite=SQLITE_IOERR_SHORT_READ)');
  });

  it('drops a code or class name that is not a plain identifier', () => {
    const error = Object.assign(new Error('x'), { code: `bad code ${SECRET}`, name: 'has space' });
    expect(describeErrorCauses(error)).toBe('Error');
  });

  it('accepts a numeric code', () => {
    expect(describeErrorCauses(Object.assign(new Error('x'), { code: 7 }))).toBe('Error(code=7)');
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
