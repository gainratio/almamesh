/**
 * The in-app pages had no route to /how-we-test: AppLayout's shared footer is
 * off by default, so the claim "linked from every footer" was false on
 * /dashboard, /report and /predictive. Settings (one tap from every app page,
 * via the gear) carries the quiet legal footer, so the page is reachable
 * without adding anything to the dashboard.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLanguageStore } from '@almamesh/store';

import '../../../i18n/config';
import { AppLayout } from '../../../components/features/layout/AppLayout';
import SettingsLayout from '../SettingsLayout';

describe('SettingsLayout footer', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
  });

  it('links to How we test (and the legal pages) from its footer, inside the app shell', () => {
    // Rendered as the router does: inside AppLayout, whose own footer is off.
    render(
      <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/settings/profile']}>
        <AppLayout>
          <Routes>
            <Route path="/settings" element={<SettingsLayout />}>
              <Route path="profile" element={<div />} />
            </Route>
          </Routes>
        </AppLayout>
      </MemoryRouter>
      </QueryClientProvider>,
    );

    const footers = document.querySelectorAll('footer');
    expect(footers).toHaveLength(1);
    const footer = footers[0] as HTMLElement;
    const hrefs = within(footer).getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(expect.arrayContaining(['/how-we-test', '/privacy', '/terms', '/data-deletion']));
    expect(within(footer).getByRole('link', { name: 'How we test' }).getAttribute('href')).toBe('/how-we-test');
  });
});
