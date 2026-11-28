import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { beginSignIn } from '../../lib/drive/oauthRedirect';
import { createMemoryCredentials } from '../../lib/drive/testing/memoryCredentials';
import * as driveSession from '../../lib/drive/driveSession';
import { OAuthCallback } from '../OAuthCallback';

const realFinishGoogleCallback = driveSession.finishGoogleCallback;

beforeEach(() => {
  sessionStorage.clear();
  document.head.innerHTML = '';
});

describe('OAuthCallback', () => {
  it('completes callback under StrictMode, sets noindex, scrubs URL, and navigates back', async () => {
    const creds = createMemoryCredentials();
    const state = beginSignIn({ provider: 'google-drive', returnTo: '/settings/data' }, 1_000);
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const spy = vi.spyOn(driveSession, 'finishGoogleCallback').mockImplementation(() =>
      realFinishGoogleCallback(
        {
          location: {
            pathname: '/oauth/callback',
            hash: `#access_token=ya29.strict&expires_in=3600&state=${state}`,
            search: '',
          } as Location,
          history: window.history,
        },
        creds,
        () => 2_000,
      ),
    );

    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/oauth/callback']}>
          <Routes>
            <Route path="/oauth/callback" element={<OAuthCallback />} />
            <Route path="/settings/data" element={<div data-testid="arrived-settings">Settings</div>} />
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    );

    await waitFor(() => expect(screen.getByTestId('arrived-settings')).toBeTruthy());
    expect(replaceState).toHaveBeenCalledWith(null, '', '/oauth/callback');
    expect((await creds.read('google-drive'))?.accessToken).toBe('ya29.strict');
    spy.mockRestore();
  });

  it('shows an explicit error and back button when CSRF state is missing or invalid', async () => {
    render(
      <MemoryRouter initialEntries={['/oauth/callback']}>
        <Routes>
          <Route path="/oauth/callback" element={<OAuthCallback />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('oauth-callback-error')).toBeTruthy());
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
      'noindex, nofollow',
    );
    expect(screen.getByTestId('oauth-callback-back')).toBeTruthy();
  });

  it('surfaces an explicit error and back button instead of hanging if credential storage rejects', async () => {
    const spy = vi
      .spyOn(driveSession, 'finishGoogleCallback')
      .mockRejectedValueOnce(new Error('IndexedDB blocked'));
    render(
      <MemoryRouter initialEntries={['/oauth/callback']}>
        <Routes>
          <Route path="/oauth/callback" element={<OAuthCallback />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('oauth-callback-error')).toBeTruthy());
    expect(screen.getByTestId('oauth-callback-back')).toBeTruthy();
    spy.mockRestore();
  });
});
