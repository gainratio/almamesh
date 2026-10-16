/**
 * Harish 2026-10-16: Settings and "How we test" showed two stacked headers, the app shell's and the
 * page's own (SettingsLayout, LegalPageLayout). Inside the shell there is exactly one header. The
 * legal pages are also prerendered with no shell (prerender-entry.tsx), where their own header is the
 * only one and stays.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { useLanguageStore } from '@almamesh/store';

import '../../../i18n/config';
import HowWeTest from '../../../pages/legal/HowWeTest';
import PrivacyPolicy from '../../../pages/legal/PrivacyPolicy';
import SettingsLayout from '../../../pages/settings/SettingsLayout';
import { AppLayout } from './AppLayout';

beforeEach(() => useLanguageStore.setState({ language: 'en' }));

function inShell(path: string) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <AppLayout>
          <Routes>
            <Route path="/settings" element={<SettingsLayout />}><Route path="profile" element={<div />} /></Route>
            <Route path="/how-we-test" element={<HowWeTest />} />
            <Route path="/privacy" element={<PrivacyPolicy />} />
          </Routes>
        </AppLayout>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('one header inside the app shell', () => {
  it.each(['/settings/profile', '/how-we-test', '/privacy'])('%s shows exactly one header', (path) => {
    inShell(path);
    expect(document.querySelectorAll('header')).toHaveLength(1);
    expect(screen.getAllByRole('banner')).toHaveLength(1);
  });

  it('Settings keeps its way back to the dashboard', () => {
    inShell('/settings/profile');
    expect(screen.getByTestId('back-to-dashboard-link').getAttribute('href')).toBe('/dashboard');
  });

  it('a legal page keeps its Back button', () => {
    inShell('/how-we-test');
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
  });
});

describe('a legal page with no shell (prerender)', () => {
  it('keeps its own single header, with the logo and Back', () => {
    render(<MemoryRouter><HowWeTest /></MemoryRouter>);
    expect(document.querySelectorAll('header')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
  });
});
