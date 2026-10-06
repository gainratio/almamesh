/**
 * Adding a person asks for their name ONCE.
 *
 * Both "add a person" entry points (Settings → People / mesh's AddPersonDialog,
 * and the header ProfileSwitcher) take a name, write it to the PROFILES store,
 * then navigate to `/onboarding`. The wizard reads a DIFFERENT store
 * (`useOnboardingStore`, whose `data.name` starts empty) — so the very next
 * screen used to ask for the name that was just typed.
 *
 * These tests drive the real wizard page, not a probe: the assertion is that
 * the wizard's own `name-input` is already filled in.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useState, type ReactElement } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLanguageStore, useOnboardingStore, useProfilesStore } from '@almamesh/store';

import '../../i18n/config';

// The engine provider is irrelevant to step 1 of the wizard; stub it so the
// page mounts (same stub Onboarding.chrome.test.tsx uses).
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

// The dashboard half of the journey below needs the same three stubs its own
// suite uses; the wizard touches none of them.
vi.mock('../../lib/localChartRead', () => ({ readLocalPrimaryChart: vi.fn() }));
vi.mock('../../providers/chartEngineContext', () => ({
  useChartEngine: () => ({ meta: null }),
  useOptionalChartEngine: () => null,
  ChartEngineContext: { Provider: ({ children }: { children: unknown }) => children },
}));
vi.mock('../../components/features/dashboard', () => ({
  ChartVisualization: () => null,
  IdentityStrip: () => null,
  LifeAtlas: () => null,
  DashboardInterpretation: () => null,
  ReadingGrounding: () => null,
}));

import { AddPersonDialog } from '../../components/features/people/AddPersonDialog';
import { ProfileSwitcher } from '../../components/features/profiles/ProfileSwitcher';
import { readLocalPrimaryChart } from '../../lib/localChartRead';
import DashboardPage from '../Dashboard';
import OnboardingPage from '../Onboarding';

/** The dialog opened in place, exactly as Settings → People opens it. */
function OpenAddPersonDialog(): ReactElement {
  const [open, setOpen] = useState(true);
  return <AddPersonDialog open={open} onClose={() => setOpen(false)} />;
}

/** Render an entry point at `/people`, with the REAL wizard at `/onboarding`. */
function renderFlow(entry: ReactElement): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/people']}>
        <Routes>
          <Route path="/people" element={entry} />
          <Route path="/onboarding" element={<OnboardingPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function wizardNameInput(): HTMLInputElement {
  return screen.getByTestId('name-input') as HTMLInputElement;
}

/** Land on the wizard directly, the way every in-app link into it does. */
function renderWizard(): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/onboarding']}>
        <Routes>
          <Route path="/onboarding" element={<OnboardingPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function seedActivePerson(name: string): string {
  const id = useProfilesStore.getState().createProfile(name);
  useProfilesStore.getState().setActiveProfile(id);
  return id;
}

describe('adding a person hands the name to the onboarding wizard', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
    useProfilesStore.setState({ profiles: {}, activeProfileId: null, hydrated: true });
    useOnboardingStore.getState().reset();
  });

  it('AddPersonDialog: the wizard opens with the name already filled in', async () => {
    renderFlow(<OpenAddPersonDialog />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Amma' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add & enter birth details' }));

    await screen.findByTestId('name-input');
    expect(wizardNameInput().value).toBe('Amma');
  });

  it('ProfileSwitcher: the wizard opens with the name already filled in', async () => {
    renderFlow(<ProfileSwitcher />);

    fireEvent.click(screen.getByRole('button', { name: 'Add a person' }));
    fireEvent.change(screen.getByLabelText('New person name'), { target: { value: 'Ravi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await screen.findByTestId('name-input');
    expect(wizardNameInput().value).toBe('Ravi');
  });

  it('the handed-over name is the trimmed one that was stored on the profile', async () => {
    renderFlow(<OpenAddPersonDialog />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Meera  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add & enter birth details' }));

    await screen.findByTestId('name-input');
    const created = useProfilesStore
      .getState()
      .listProfiles()
      .find((p) => p.name === 'Meera');
    expect(created).toBeDefined();
    expect(wizardNameInput().value).toBe('Meera');
  });
});

/**
 * The wizard itself knows who it is for.
 *
 * Not every route into `/onboarding` passes through an "add a person" form —
 * the chart-less dashboard's "Add birth details" is a plain link, and so is a
 * pasted URL. Those arrive with an ACTIVE profile the app already named, and
 * the wizard (a different store, `name: ''`) used to ask for it again.
 *
 * The seed is at the wizard's own mount, and fires ONLY when the wizard's name
 * is empty: the onboarding store has no persistence and `reset()` runs only
 * after a chart is generated, so a non-empty name is always one THIS session
 * typed and must never be overwritten.
 */
describe('the onboarding wizard seeds its name from the active person', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
    useProfilesStore.setState({ profiles: {}, activeProfileId: null, hydrated: true });
    useOnboardingStore.getState().reset();
  });

  it('prefills from the active profile when the wizard arrives empty', async () => {
    seedActivePerson('Ravi');
    renderWizard();

    await screen.findByTestId('name-input');
    expect(wizardNameInput().value).toBe('Ravi');
  });

  it('never clobbers a name the user is part-way through typing', async () => {
    seedActivePerson('Ravi');
    // A returning user mid-wizard: they typed "Al" and came back to the page.
    useOnboardingStore.getState().setName('Al');
    renderWizard();

    await screen.findByTestId('name-input');
    expect(wizardNameInput().value).toBe('Al');
    expect(useOnboardingStore.getState().data.name).toBe('Al');
  });

  it('does not re-seed when the user deliberately clears the field', async () => {
    seedActivePerson('Ravi');
    renderWizard();
    await screen.findByTestId('name-input');
    expect(wizardNameInput().value).toBe('Ravi');

    // Clearing must stick — a seed that re-fires on empty fights the user.
    fireEvent.change(wizardNameInput(), { target: { value: '' } });

    expect(wizardNameInput().value).toBe('');
    expect(useOnboardingStore.getState().data.name).toBe('');
  });

  it('leaves the name empty when nobody is active', async () => {
    renderWizard();

    await screen.findByTestId('name-input');
    expect(wizardNameInput().value).toBe('');
  });

  it('the chart-less dashboard’s rebuild button lands on birth details for that person', async () => {
    // The exact journey: a person with no chart sees the empty state, clicks the
    // primary action, and the wizard already knows their name. This link passes
    // through no form, so ONLY the wizard-mount seed can carry the name.
    vi.mocked(readLocalPrimaryChart).mockResolvedValue({
      success: false,
      message: 'No chart found on this device.',
      person_name: '',
      chart_data_stored: false,
      generated_at: new Date(0).toISOString(),
    });
    seedActivePerson('Ravi');

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/dashboard']}>
          <Routes>
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/onboarding" element={<OnboardingPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByTestId('no-chart-create'));

    // Since the 2026-10-05 rebuild button, the link names the person
    // (?person=<id>), so the wizard skips the name step entirely and opens
    // at birth details with the name already carried.
    await screen.findByTestId('birth-date-input');
    expect(screen.queryByTestId('name-input')).toBeNull();
    expect(useOnboardingStore.getState().data.name).toBe('Ravi');
  });

  it('adding a NEW person still overrides a stale half-typed name', async () => {
    // The mount seed is empty-only by design, so it CANNOT fix this case: the
    // stale "Al" belongs to an abandoned wizard, not to the person being added.
    // The explicit hand-off in the add-person flows is what covers it.
    useOnboardingStore.getState().setName('Al');
    renderFlow(<OpenAddPersonDialog />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Amma' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add & enter birth details' }));

    await screen.findByTestId('name-input');
    expect(wizardNameInput().value).toBe('Amma');
  });
});
