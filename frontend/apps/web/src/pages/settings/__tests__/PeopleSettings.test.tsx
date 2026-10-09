/**
 * PeopleSettings — the mesh "people layer" management surface.
 *
 * Drives the REAL profiles store (no mocks): relationship badges, the
 * one-anchor "This is me" flow, the relationship picker, the honest empty
 * state, and the add-a-person CTA that reuses the existing onboarding flow.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * happy-dom has NO IndexedDB (`typeof indexedDB === 'undefined'`), so the real
 * `beginDatasetMutation()` returns the sentinel epoch `0` — which is NOT
 * `undefined`, so `deleteProfileData` then calls `replaceLiveDataset()` to
 * re-sync live memory against the durable dataset. In production that dataset
 * holds the data; in this harness there is no durable layer at all, so EVERY
 * store gets cleared and the delete fails with "profile does not exist" — while
 * a naive test asserting only "the person is gone" still goes green, because a
 * wipe removes them too. That is a guard measuring shape, not property.
 *
 * Stubbing this ONE unavailable environment primitive (the dataset lease)
 * reproduces the "no lease" branch and leaves the ENTIRE real cascade under
 * test. Every assertion below reads real store state, and the tests now also
 * pin what must SURVIVE — which is what tells a cascade apart from a wipe.
 */
vi.mock('@almamesh/store', async () => {
  const actual = await vi.importActual<typeof import('@almamesh/store')>('@almamesh/store');
  return { ...actual, beginDatasetMutation: vi.fn().mockResolvedValue(undefined) };
});

import {
  setActiveProfileScope,
  useChartLibraryStore,
  useChatStore,
  useInterpretationStore,
  useLanguageStore,
  useLifeEventsStore,
  useMeshStore,
  usePredictiveStore,
  useProfilesStore,
  useRectificationRecordsStore,
  type StoredChart,
} from '@almamesh/store';

import '../../../i18n/config';
import { __resetMemoryForTest, __setMemoryForTest } from '../../../lib/chatMemory';
import PeopleSettings from '../PeopleSettings';

function renderPage() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/settings/people']}>
        <Routes>
          <Route path="/settings/people" element={<PeopleSettings />} />
          <Route path="/onboarding" element={<div data-testid="onboarding-probe" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function seed(name: string): string {
  return useProfilesStore.getState().createProfile(name);
}

describe('PeopleSettings', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
    useProfilesStore.setState({ profiles: {}, activeProfileId: null, hydrated: true });
  });

  it('shows the honest empty-mesh explainer while no members exist', () => {
    seed('Asha');
    renderPage();
    expect(screen.getByText('Your mesh is empty')).toBeTruthy();
    expect(screen.getByText(/Add the people close to you — family first/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add a person' })).toBeTruthy();
  });

  it('lists every profile with its relationship badge', () => {
    const me = seed('Asha');
    const mom = seed('Amma');
    const plain = seed('Stranger');
    useProfilesStore.getState().setAnchor(me);
    useProfilesStore.getState().setRelationship(mom, 'mother');
    renderPage();

    expect(within(screen.getByTestId(`person-row-${me}`)).getByText('You')).toBeTruthy();
    expect(
      within(screen.getByTestId(`person-row-${mom}`)).getByTestId('relationship-badge')
        .textContent,
    ).toBe('Mother');
    const plainRow = screen.getByTestId(`person-row-${plain}`);
    expect(
      (within(plainRow).getByLabelText('Relationship of Stranger to you') as HTMLSelectElement)
        .value,
    ).toBe('');
  });

  it('"This is me" marks the anchor and removes the option from other rows', () => {
    const a = seed('Alice');
    const b = seed('Bob');
    renderPage();

    // Before any anchor: every row offers "This is me".
    expect(screen.getAllByRole('button', { name: 'This is me' })).toHaveLength(2);
    fireEvent.click(within(screen.getByTestId(`person-row-${a}`)).getByRole('button', { name: 'This is me' }));

    expect(useProfilesStore.getState().getAnchorProfile()?.id).toBe(a);
    expect(within(screen.getByTestId(`person-row-${a}`)).getByText('You')).toBeTruthy();
    // The one-anchor invariant: no other row may offer "This is me" now.
    expect(screen.queryByRole('button', { name: 'This is me' })).toBeNull();
    expect(useProfilesStore.getState().profiles[b]?.relationship).toBeUndefined();
  });

  it('assigning a relationship through the picker updates the store and links the anchor', () => {
    const me = seed('Asha');
    const mom = seed('Amma');
    useProfilesStore.getState().setAnchor(me);
    renderPage();

    fireEvent.change(screen.getByLabelText('Relationship of Amma to you'), {
      target: { value: 'mother' },
    });

    expect(useProfilesStore.getState().profiles[mom]?.relationship).toBe('mother');
    expect(useProfilesStore.getState().profiles[mom]?.relatedTo).toBe(me);
    expect(
      within(screen.getByTestId(`person-row-${mom}`)).getByTestId('relationship-badge')
        .textContent,
    ).toBe('Mother');
  });

  it('shows the mesh-ready status once an anchor and a member exist', () => {
    const me = seed('Asha');
    const mom = seed('Amma');
    useProfilesStore.getState().setAnchor(me);
    useProfilesStore.getState().setRelationship(mom, 'mother');
    renderPage();
    expect(screen.getByText(/Mesh ready — 1 person connected to you/)).toBeTruthy();
  });

  it('unmark releases the anchor so someone else can be chosen', () => {
    const me = seed('Asha');
    useProfilesStore.getState().setAnchor(me);
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Unmark' }));

    expect(useProfilesStore.getState().getAnchorProfile()).toBeUndefined();
    expect(screen.getAllByRole('button', { name: 'This is me' })).toHaveLength(1);
  });

  it('add a person creates the profile, assigns the relationship, and routes into onboarding', async () => {
    const me = seed('Asha');
    useProfilesStore.getState().setAnchor(me);
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Add a person' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Amma' } });
    fireEvent.change(screen.getByLabelText('Relationship to you'), {
      target: { value: 'mother' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add & enter birth details' }));

    // Routed through the EXISTING flow once the person is saved: new person
    // active, sent to onboarding.
    expect(await screen.findByTestId('onboarding-probe')).toBeTruthy();
    const created = useProfilesStore
      .getState()
      .listProfiles()
      .find((p) => p.name === 'Amma');
    expect(created).toBeDefined();
    expect(created?.relationship).toBe('mother');
    expect(created?.relatedTo).toBe(me);
    expect(useProfilesStore.getState().activeProfileId).toBe(created?.id);
  });
});

/**
 * Rename + delete used to exist ONLY in the header ProfileSwitcher, so the page
 * literally called "People" could neither rename nor remove a person. Both
 * actions now live here, reusing the same store action (`renameProfile`) and
 * the same cascading lifecycle coordinator (`deleteProfileData`) — never the
 * raw `deleteProfile`, which would strand the person's charts and chat.
 */
function chartFor(profileId: string, chartId: string): StoredChart {
  return {
    chart_id: chartId,
    profile_id: profileId,
    person_name: profileId,
    is_primary: true,
  } as StoredChart;
}

describe('PeopleSettings — rename and delete', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
    setActiveProfileScope(null);
    useProfilesStore.setState({ profiles: {}, activeProfileId: null, hydrated: true });
    useChartLibraryStore.setState({ charts: {} });
    useChatStore.setState({ threads: {}, messages: {} });
    useLifeEventsStore.setState({ eventsByProfile: {} });
    useInterpretationStore.setState({ byChart: {} });
    useRectificationRecordsStore.setState({ recordsByProfile: {} });
    usePredictiveStore.getState().reset();
    useMeshStore.setState({ edges: {} });
    // The semantic-memory index is a wasm-backed worker singleton; the real
    // cascade is exercised, only its embedder is stubbed via the module's
    // own test seam. Every assertion below reads REAL store state.
    __setMemoryForTest({
      indexMessage: vi.fn().mockResolvedValue(undefined),
      retrieve: vi.fn().mockResolvedValue([]),
      deleteForProfile: vi.fn().mockResolvedValue(undefined),
      deleteForThread: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    __resetMemoryForTest();
  });

  it('renames a person in place and shows the new name', () => {
    const mom = seed('Amma');
    seed('Asha');
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Rename Amma' }));
    const field = screen.getByLabelText('Rename Amma') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'Amma Devi' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(useProfilesStore.getState().profiles[mom]?.name).toBe('Amma Devi');
    expect(within(screen.getByTestId(`person-row-${mom}`)).getByText('Amma Devi')).toBeTruthy();
  });

  it('deletes a person only after a confirm, and cascades every artifact they own', async () => {
    const mom = seed('Amma');
    const asha = seed('Asha');
    useChartLibraryStore.setState({
      charts: {
        'chart-amma': chartFor(mom, 'chart-amma'),
        'chart-asha': chartFor(asha, 'chart-asha'),
      },
    });
    // Life events + chat threads are cleared ONLY by the lifecycle coordinator.
    // The chart store alone is NOT a witness: the profiles store drops a
    // deleted person's charts by itself, so a raw `deleteProfile` would leave
    // a chart-only assertion green. These two are what tell them apart.
    useLifeEventsStore.getState().setEvents(mom, [{ date: '2020-01-01', description: 'new job' }]);
    useLifeEventsStore
      .getState()
      .setEvents(asha, [{ date: '2021-01-01', description: 'promotion' }]);
    useChatStore.getState().ensureThread(mom, 'chart-amma');
    useChatStore.getState().ensureThread(asha, 'chart-asha');
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Amma' }));
    // Destructive: the row asks first, and the person is still there.
    expect(screen.getByText(/Delete Amma and their charts\?/)).toBeTruthy();
    expect(useProfilesStore.getState().profiles[mom]).toBeDefined();

    fireEvent.click(screen.getByTestId(`confirm-delete-${mom}`));

    await waitFor(() => {
      expect(useProfilesStore.getState().profiles[mom]).toBeUndefined();
    });
    await waitFor(() => {
      expect(useLifeEventsStore.getState().eventsByProfile[mom] ?? []).toHaveLength(0);
    });
    expect(useChatStore.getState().listThreads(mom)).toHaveLength(0);
    expect(useChartLibraryStore.getState().charts['chart-amma']).toBeUndefined();
    // …and it was a CASCADE, not a wipe: everyone else keeps their data.
    expect(useProfilesStore.getState().profiles[asha]).toBeDefined();
    expect(useChartLibraryStore.getState().charts['chart-asha']).toBeDefined();
    expect(useLifeEventsStore.getState().eventsByProfile[asha] ?? []).toHaveLength(1);
    expect(useChatStore.getState().listThreads(asha)).toHaveLength(1);
    expect(screen.queryByTestId('delete-person-error')).toBeNull();
    expect(screen.queryByTestId(`person-row-${mom}`)).toBeNull();
    expect(screen.getByTestId(`person-row-${asha}`)).toBeTruthy();
  });

  it('surfaces a failed delete instead of silently swallowing it', async () => {
    const mom = seed('Amma');
    seed('Asha');
    // The cascade fails at its final step; the page must say so, not pretend.
    useProfilesStore.setState({
      deleteProfile: () => {
        throw new Error('storage went away mid-delete');
      },
    });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Amma' }));
    fireEvent.click(screen.getByTestId(`confirm-delete-${mom}`));

    const notice = await screen.findByTestId('delete-person-error');
    expect(notice.textContent ?? '').toContain('storage went away mid-delete');
    expect(useProfilesStore.getState().profiles[mom]).toBeDefined();
  });

  it('refuses to delete the last person — the store would throw', () => {
    const only = seed('Asha');
    renderPage();

    const button = within(screen.getByTestId(`person-row-${only}`)).getByRole('button', {
      name: 'Delete Asha',
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('At least one person must remain');
  });
});
