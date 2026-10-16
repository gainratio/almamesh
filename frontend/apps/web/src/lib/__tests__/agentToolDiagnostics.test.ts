import { beforeEach, describe, expect, it } from 'vitest';

import { reportAgentToolFailure } from '../agentToolDiagnostics';
import { useAppStale } from '../appStale';

beforeEach(() => useAppStale.setState({ stale: false }));

describe('a tool that failed on a stale chunk marks the app as updated (deploy-skew finding, 2026-10-13)', () => {
  it('a chunk-load failure inside a tool raises the update notice', () => {
    reportAgentToolFailure(new TypeError('Failed to fetch dynamically imported module: /assets/placeLookup-a1.js'));
    expect(useAppStale.getState().stale).toBe(true);
  });

  it('any other tool failure does not', () => {
    reportAgentToolFailure(new DOMException('timed out', 'TimeoutError'));
    expect(useAppStale.getState().stale).toBe(false);
  });
});
