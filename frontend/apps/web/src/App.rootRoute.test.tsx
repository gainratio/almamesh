import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useChartLibraryStore } from '@almamesh/store';

import './i18n/config';

// Mock the engine-bootstrap provider hook so App renders without a real engine.
vi.mock('./providers/chartEngineContext', () => ({
  useChartEngine: () => ({ startBootstrap: () => {} }),
  useOptionalChartEngine: () => null,
}));

// The landing page is heavy (force-field); stub it to a marker so the routing
// test asserts WHICH element renders at `/`, not the page internals.
vi.mock('./pages/Landing', () => ({
  default: ({ variant }: { variant: string }) => (
    <div data-testid="landing-page" data-variant={variant}>landing</div>
  ),
}));

// The Dashboard page is heavy (react-query / chart reads); stub it to a marker so
// the redirect test asserts WHERE the router lands, not Dashboard internals.
vi.mock('./pages/Dashboard', () => ({
  default: () => <div data-testid="dashboard-page">dashboard</div>,
}));

// AppLayout chrome carries the profile switcher + AI status badge — the landing
// must render OUTSIDE this shell. Stub it to a recognizable marker.
vi.mock('./components/features/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-layout-chrome">{children}</div>
  ),
}));

// UpdateBanner pulls `virtual:pwa-register` (a build-time virtual module that
// does not exist under vitest); stub it — it is irrelevant to routing.
vi.mock('./components/UpdateBanner', () => ({ UpdateBanner: () => null }));

// Avoid pulling the real lazy app pages / side-effectful hooks.
vi.mock('./hooks/useChatScopeSync', () => ({ useChatScopeSync: () => {} }));
vi.mock('./hooks/useLanguageSync', () => ({ useLanguageSync: () => {} }));
vi.mock('./hooks/useRegenerationSubscription', () => ({
  useRegenerationSubscription: () => {},
}));
vi.mock('./hooks/useChartReanchor', () => ({ useChartReanchor: () => {} }));

import App from './App';

const setHasChart = (hasChart: boolean) =>
  useChartLibraryStore.setState({
    charts: hasChart
      ? ({ saved: { chart_id: 'saved', person_name: 'Saved', is_primary: true } } as never)
      : {},
  });

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('RootRoute (/)', () => {
  beforeEach(() => {
    setHasChart(false);
  });

  it('renders the LandingPage for a first-time visitor with no chart', async () => {
    renderAt('/');
    expect((await screen.findByTestId('landing-page')).getAttribute('data-variant')).toBe('home');
  });

  it('renders the landing OUTSIDE the AppLayout chrome', async () => {
    renderAt('/');
    await screen.findByTestId('landing-page');
    // The profile-switcher / AI-status app shell must NOT wrap the splash.
    expect(screen.queryByTestId('app-layout-chrome')).toBeNull();
  });

  it('redirects a returning visitor with a chart to /dashboard', async () => {
    setHasChart(true);
    renderAt('/');
    // The redirect lands on the dashboard, inside the AppLayout chrome.
    expect(await screen.findByTestId('dashboard-page')).toBeTruthy();
    expect(screen.getByTestId('app-layout-chrome')).toBeTruthy();
    // And it is NOT the landing splash.
    expect(screen.queryByTestId('landing-page')).toBeNull();
  });
});

describe('unknown routes', () => {
  it('renders a noindex not-found page instead of redirecting to the root landing', async () => {
    renderAt('/definitely-not-a-route');

    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(screen.queryByTestId('landing-page')).toBeNull();
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
      'noindex, nofollow',
    );
  });
});
