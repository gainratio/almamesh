/**
 * The in-app pages had no route to /how-we-test: AppLayout's shared footer is
 * off by default, so the claim "linked from every footer" was false on
 * /dashboard, /report and /predictive. Settings (one tap from every app page,
 * via the gear) carries the quiet legal footer, so the page is reachable
 * without adding anything to the dashboard.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useLanguageStore } from '@almamesh/store';

import '../../../i18n/config';
import SettingsLayout from '../SettingsLayout';

describe('SettingsLayout footer', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
  });

  it('links to How we test (and the legal pages) from a footer landmark', () => {
    render(
      <MemoryRouter initialEntries={['/settings/profile']}>
        <Routes>
          <Route path="/settings" element={<SettingsLayout />}>
            <Route path="profile" element={<div />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const footer = screen.getByRole('contentinfo');
    const hrefs = within(footer).getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(expect.arrayContaining(['/how-we-test', '/privacy', '/terms', '/data-deletion']));
    expect(within(footer).getByRole('link', { name: 'How we test' }).getAttribute('href')).toBe('/how-we-test');
  });
});
