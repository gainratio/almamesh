// frontend/apps/web/e2e/ai-setup-panel.recorder.spec.ts
import { expect, test, type Request } from '@playwright/test';

import { readAuthorization } from './aiSetupPanel.helpers';

/**
 * The egress recorder's header read: a request whose worker has closed makes
 * `headerValue` reject ("Worker closed") or never settle. The read must neither
 * crash nor hang the recorder, and must still return the header the page set.
 * No browser needed; runs in the same CI config as the egress spec.
 */

interface FakeRequestParts {
  headerValue: () => Promise<string | null>;
  provisional: Record<string, string>;
}

function fakeRequest(parts: FakeRequestParts): Request {
  const fake: Pick<Request, 'headerValue' | 'headers'> = {
    headerValue: parts.headerValue,
    headers: () => parts.provisional,
  };
  return fake as Request;
}

const KEYED = { authorization: 'Bearer sk-or-test' };

test.describe('readAuthorization', () => {
  test('returns the full header when the read succeeds', async () => {
    const request = fakeRequest({ headerValue: async () => 'Bearer full', provisional: KEYED });
    expect(await readAuthorization(request)).toBe('Bearer full');
  });

  test('falls back to the provisional header when the worker closed', async () => {
    const request = fakeRequest({
      headerValue: async () => {
        throw new Error('request.headerValue: Worker closed');
      },
      provisional: KEYED,
    });
    expect(await readAuthorization(request)).toBe('Bearer sk-or-test');
  });

  test('falls back to the provisional header when the read never settles', async () => {
    const request = fakeRequest({ headerValue: () => new Promise(() => undefined), provisional: KEYED });
    expect(await readAuthorization(request, 50)).toBe('Bearer sk-or-test');
  });

  test('is null only when no header was set anywhere', async () => {
    const request = fakeRequest({ headerValue: async () => null, provisional: {} });
    expect(await readAuthorization(request)).toBeNull();
  });
});
