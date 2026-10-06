import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import '../../i18n/config';
import { useOnboardingStore } from '@almamesh/store';
import i18n from '../../i18n/config';

// The engine provider is irrelevant to page chrome; stub it so the page mounts.
vi.mock('../../providers/AlmaMeshRuntimeProvider', () => ({
  useChartEngine: () => ({
    engine: null,
    error: null,
    stage: null,
    meta: null,
    reboot: vi.fn(),
    whenReady: vi.fn(),
    startBootstrap: vi.fn(),
  }),
}));

import { AppLayout } from '../../components/features/layout/AppLayout';
import OnboardingPage from '../Onboarding';

/**
 * Render the page exactly as the router does: inside `AppLayout`.
 * `/onboarding` is declared inside `AppRoutes`, which wraps every route in
 * `AppLayout` — so the page is ALWAYS mounted inside the app shell.
 */
function renderInShell() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/onboarding']}>
        <AppLayout>
          <OnboardingPage />
        </AppLayout>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Onboarding page chrome', () => {
  beforeEach(() => {
    useOnboardingStore.getState().reset();
  });

  it('renders exactly one app header — AppLayout owns the chrome', () => {
    renderInShell();
    // Two stacked `sticky top-0 z-40` headers (AppLayout's + a page-level one)
    // produced a duplicated wordmark and a dead ghost bar on every viewport.
    expect(screen.getAllByRole('banner')).toHaveLength(1);
  });

  it('renders exactly one AlmaMesh wordmark', () => {
    renderInShell();
    const wordmarks = screen
      .getAllByRole('link')
      .filter((el) => /^\s*almamesh\s*$/i.test(el.textContent ?? ''));
    expect(wordmarks).toHaveLength(1);
  });
});

describe('Onboarding step indicator', () => {
  beforeEach(() => {
    useOnboardingStore.getState().reset();
  });

  it('exposes a compact step counter that does not depend on fitting five labels', () => {
    renderInShell();
    // The five-label row cannot fit a narrow viewport in every locale
    // (es: "Fecha de nacimiento" / "Hora de nacimiento"). A counter is the
    // locale-proof progress signal.
    expect(screen.getByText('Step 1 of 5')).toBeTruthy();
  });

  it('localises the step counter', async () => {
    await i18n.changeLanguage('es');
    renderInShell();
    expect(screen.getByText('Paso 1 de 5')).toBeTruthy();
    await i18n.changeLanguage('en');
  });
});

describe('Onboarding first step: restore instead of starting over', () => {
  beforeEach(() => {
    useOnboardingStore.getState().reset();
  });

  it('offers "Restore from a backup" on the first step', () => {
    renderInShell();
    expect(screen.getByRole('button', { name: 'Restore from a backup' })).toBeTruthy();
  });

  it('localises the restore entry', async () => {
    await i18n.changeLanguage('pt');
    renderInShell();
    expect(screen.getByRole('button', { name: 'Restaurar de um backup' })).toBeTruthy();
    await i18n.changeLanguage('en');
  });
});
