import { afterEach, describe, expect, it, vi } from 'vitest';
import { TYPED_ERROR_CAUSE_MARKER } from '@almamesh/shared-types';

import { CityLookupError } from './geo/cityLookup';
import { reportAgentToolFailure } from './agentToolDiagnostics';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const failure = new CityLookupError('geo.city_import', new TypeError('Load failed for Bogotá'));

describe('reportAgentToolFailure', () => {
  it('says a chat tool failed, naming the step and cause class in hook builds, never the text', () => {
    vi.stubEnv('VITE_EXIT_GATE_HOOKS', '1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    reportAgentToolFailure(failure);
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines).toEqual([
      '[almamesh:warn:chat.tool_failed]',
      `[${TYPED_ERROR_CAUSE_MARKER}] CityLookupError(code=geo.city_import) <- TypeError`,
    ]);
    expect(lines.join('\n')).not.toContain('Bogotá');
  });

  it('prints only the fixed code in a production build', () => {
    vi.stubEnv('VITE_EXIT_GATE_HOOKS', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    reportAgentToolFailure(failure);
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual(['[almamesh:warn:chat.tool_failed]']);
  });
});
