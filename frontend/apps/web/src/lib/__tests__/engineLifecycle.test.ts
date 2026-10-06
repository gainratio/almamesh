import { afterEach, describe, expect, it, vi } from 'vitest';

import { EngineOperationError } from '@almamesh/browser';

import {
  engineErrorCode,
  isRollbackRefusal,
  lastEngineBootFailure,
  recordEngineBootFailure,
  registerEngineTeardown,
  teardownLiveEngine,
} from '../engineLifecycle';

/** The main-thread error @gainratio/browser raises for a Worker refusal. */
function engineOperationError(code: 'rollback' | 'integrity' | 'storage'): Error {
  return new EngineOperationError({ code, message: `refused (${code})` });
}

/** A library subclass (e.g. @gainratio/browser 0.3.1's EngineStorageUnavailableError). */
class EngineStorageUnavailableError extends EngineOperationError {
  constructor() {
    super({ code: 'storage', message: 'OPFS refused' });
    this.name = 'EngineStorageUnavailableError';
  }
}

afterEach(() => {
  recordEngineBootFailure(null);
});

describe('engineErrorCode / isRollbackRefusal', () => {
  it('reads the EngineOperationError code, including through a wrapping cause', () => {
    expect(engineErrorCode(engineOperationError('rollback'))).toBe('rollback');
    const wrapped = new Error('Engine bootstrap failed', { cause: engineOperationError('rollback') });
    expect(engineErrorCode(wrapped)).toBe('rollback');
    expect(isRollbackRefusal(wrapped)).toBe(true);
  });

  it('is not a rollback for other codes, plain errors, or non-errors', () => {
    expect(isRollbackRefusal(engineOperationError('integrity'))).toBe(false);
    expect(isRollbackRefusal(new Error('refusing rollback (message only is not trusted)'))).toBe(false);
    expect(isRollbackRefusal(null)).toBe(false);
    expect(engineErrorCode('rollback')).toBeNull();
  });

  it('only trusts a string code from an EngineOperationError', () => {
    const lookalike = Object.assign(new Error('x'), { code: 'rollback' });
    expect(engineErrorCode(lookalike)).toBeNull();
    const renamed = Object.assign(new Error('x'), { name: 'EngineOperationError', code: 'rollback' });
    expect(engineErrorCode(renamed)).toBeNull();
  });

  it('reads the code from a library subclass of EngineOperationError', () => {
    expect(engineErrorCode(new EngineStorageUnavailableError())).toBe('storage');
    const wrapped = new Error('Engine bootstrap failed', { cause: new EngineStorageUnavailableError() });
    expect(engineErrorCode(wrapped)).toBe('storage');
  });
});

describe('boot-failure record', () => {
  it('remembers the latest engine boot failure until cleared', () => {
    const failure = engineOperationError('rollback');
    recordEngineBootFailure(failure);
    expect(lastEngineBootFailure()).toBe(failure);
    recordEngineBootFailure(null);
    expect(lastEngineBootFailure()).toBeNull();
  });
});

describe('live-engine teardown', () => {
  it('runs the registered teardown and stops after unregister', async () => {
    const teardown = vi.fn();
    const unregister = registerEngineTeardown(teardown);
    await teardownLiveEngine();
    expect(teardown).toHaveBeenCalledTimes(1);
    unregister();
    await teardownLiveEngine();
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('never rejects when the teardown throws', async () => {
    const unregister = registerEngineTeardown(() => {
      throw new Error('boom');
    });
    await expect(teardownLiveEngine()).resolves.toBeUndefined();
    unregister();
  });
});
