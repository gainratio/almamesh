import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import './i18n/config';

// Mock the engine-bootstrap provider hook so App renders without a real engine.
vi.mock('./providers/chartEngineContext', () => ({
  useChartEngine: () => ({ startBootstrap: () => {} }),
  useOptionalChartEngine: () => null,
}));

// The landing page is heavy (force-field); stub it to a marker so the routing
// test asserts WHICH element renders at `/welcome`, not the page internals.
vi.mock('./pages/Landing', () => ({
  default: ({ variant }: { variant: string }) => (
    <div data-testid="landing-page" data-variant={variant}>landing</div>
  ),
}));

// The Dashboard page is heavy; stub it to a marker so we can prove `/welcome`
// does NOT redirect to it even when a chart exists.
vi.mock('./pages/Dashboard', () => ({
  default: () => <div data-testid="dashboard-page">dashboard</div>,
}));

// AppLayout chrome carries the profile switcher + AI status badge — the welcome
// splash must render OUTSIDE this shell, exactly like `/`.
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

const hasLocalChart = vi.fn();
vi.mock('./lib/localChart', () => ({
  hasLocalChart: () => hasLocalChart(),
}));

import App from './App';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('WelcomeRoute (/welcome)', () => {
  beforeEach(() => {
    hasLocalChart.mockReset();
  });

  it('renders the LandingPage even when a chart already exists (no redirect)', async () => {
    hasLocalChart.mockReturnValue(true);
    renderAt('/welcome');
    expect((await screen.findByTestId('landing-page')).getAttribute('data-variant')).toBe('welcome');
    // A returning visitor must NOT be bounced to the dashboard here.
    expect(screen.queryByTestId('dashboard-page')).toBeNull();
  });

  it('renders the welcome splash OUTSIDE the AppLayout chrome', async () => {
    hasLocalChart.mockReturnValue(true);
    renderAt('/welcome');
    await screen.findByTestId('landing-page');
    expect(screen.queryByTestId('app-layout-chrome')).toBeNull();
  });

  it('also renders the LandingPage for a first-time visitor with no chart', async () => {
    hasLocalChart.mockReturnValue(false);
    renderAt('/welcome');
    expect(await screen.findByTestId('landing-page')).toBeTruthy();
  });
});
