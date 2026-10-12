import { describe, expect, it } from 'vitest';

import {
  formatStageFailure,
  parseSmokeArgs,
  runStage,
  SafariSmokeStageError,
  storageModeFrom,
} from '../../scripts/safariSmoke.mjs';

const SNAPSHOT = {
  route: '/onboarding',
  heading: 'What is your name?',
  storageMode: 'opfs',
  lastErrorCode: null,
  runtimeStage: 'loading',
} as const;

describe('runStage', () => {
  it('returns the stage result when it finishes in time', async () => {
    const value = await runStage('shell', 1_000, async () => 'rendered', async () => SNAPSHOT);

    expect(value).toBe('rendered');
  });

  it('fails a stage that never finishes with its name and a JSON snapshot', async () => {
    const never = new Promise<never>(() => {});

    const failure = await runStage('dashboard-chart', 20, () => never, async () => SNAPSHOT).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(SafariSmokeStageError);
    const stageError = failure as SafariSmokeStageError;
    expect(stageError.stage).toBe('dashboard-chart');
    expect(stageError.message).toContain('timed out after 20 ms');
    expect(stageError.snapshot).toEqual(SNAPSHOT);
  });

  it('names the stage when its body throws', async () => {
    const failure = await runStage(
      'isolation',
      1_000,
      async () => {
        throw new Error('crossOriginIsolated is false');
      },
      async () => SNAPSHOT,
    ).catch((error: unknown) => error as SafariSmokeStageError);

    expect(failure.stage).toBe('isolation');
    expect(failure.message).toContain('crossOriginIsolated is false');
  });

  it('still reports the stage when the snapshot itself cannot be read', async () => {
    const failure = await runStage(
      'engine',
      1_000,
      async () => {
        throw new Error('engine failed');
      },
      async () => {
        throw new Error('session gone');
      },
    ).catch((error: unknown) => error as SafariSmokeStageError);

    expect(failure.stage).toBe('engine');
    expect(failure.snapshot).toEqual({ snapshotError: 'session gone' });
  });
});

describe('formatStageFailure', () => {
  it('prints the stage name first, then the diagnostic snapshot as JSON', () => {
    const text = formatStageFailure(new SafariSmokeStageError('engine', 'engine failed', SNAPSHOT));

    const [headline, json] = text.split('\n');
    expect(headline).toBe('safari-smoke FAILED at stage "engine": engine failed');
    expect(JSON.parse(json ?? '')).toEqual({ stage: 'engine', snapshot: SNAPSHOT });
  });
});

describe('storageModeFrom', () => {
  it('reports memory when the app shows its in-memory notice', () => {
    expect(storageModeFrom({ inMemoryNotice: true })).toBe('memory');
  });

  it('reports opfs when the app shows no in-memory notice', () => {
    expect(storageModeFrom({ inMemoryNotice: false })).toBe('opfs');
  });
});

describe('parseSmokeArgs', () => {
  it('defaults to building and serving its own preview with evidence in safari-smoke-evidence', () => {
    expect(parseSmokeArgs([])).toEqual({
      baseUrl: null,
      route: '/onboarding',
      evidenceDir: 'safari-smoke-evidence',
    });
  });

  it('accepts an existing preview, a route override and an evidence directory', () => {
    expect(
      parseSmokeArgs(['--base-url', 'http://127.0.0.1:4310', '--route', '/privacy', '--evidence', 'out']),
    ).toEqual({ baseUrl: 'http://127.0.0.1:4310', route: '/privacy', evidenceDir: 'out' });
  });

  it('rejects an unknown flag', () => {
    expect(() => parseSmokeArgs(['--headless'])).toThrow('Unknown safari-smoke argument: --headless');
  });

  it('rejects a flag with no value', () => {
    expect(() => parseSmokeArgs(['--base-url'])).toThrow('--base-url needs a value');
  });
});
