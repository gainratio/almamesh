/**
 * MeshPage — `/mesh`, the constellation graph.
 *
 * Covers the three designed states: the invitation (mesh not ready), the ready
 * radial graph (anchor centred, members as linked star nodes with name /
 * relationship / rising sign), and the muted chartless node whose "generate
 * chart" affordance reuses the established switch-profile → onboarding flow.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useChartLibraryStore,
  useLanguageStore,
  useProfilesStore,
  type Profile,
  type StoredChart,
} from '@almamesh/store';

import '../../i18n/config';
import MeshPage from '../Mesh';

const ANCHOR: Profile = {
  id: 'p-anchor',
  name: 'Asha Rao',
  createdAt: '2026-01-01T00:00:00Z',
  avatarTint: '#C9A24B',
  relationship: 'self',
};

const SPOUSE: Profile = {
  id: 'p-spouse',
  name: 'Dev Rao',
  createdAt: '2026-01-02T00:00:00Z',
  avatarTint: '#3A4FB0',
  relationship: 'spouse',
  relatedTo: 'p-anchor',
};

const FRIEND: Profile = {
  id: 'p-friend',
  name: 'Mira Sen',
  createdAt: '2026-01-03T00:00:00Z',
  avatarTint: '#7A4FB0',
  relationship: 'friend',
  relatedTo: 'p-anchor',
};

function chartFor(profileId: string, lagnaSign: string): StoredChart {
  return {
    chart_id: `chart-${profileId}`,
    person_name: 'Someone',
    is_primary: true,
    profile_id: profileId,
    birth_data: {
      birth_datetime_utc: '1990-01-15T12:00:00+00:00',
      birth_datetime_local: '1990-01-15T17:30:00',
      birth_location_details: {
        city: 'Delhi',
        latitude: 28.6139,
        longitude: 77.209,
        timezone: 'Asia/Kolkata',
      },
    },
    astronomical_calculations: {
      sidereal_ctx: { lagna: { sign: lagnaSign, longitude: 328.84 } },
    },
  } as unknown as StoredChart;
}

function renderMesh(): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/mesh']}>
        <Routes>
          <Route path="/mesh" element={<MeshPage />} />
          <Route path="/mesh/:memberId" element={<div data-testid="edge-stub" />} />
          <Route path="/onboarding" element={<div data-testid="onboarding-stub" />} />
          <Route path="/settings/people" element={<div data-testid="people-stub" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('MeshPage', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
    useProfilesStore.setState({ profiles: {}, activeProfileId: null, hydrated: true });
    useChartLibraryStore.setState({ charts: {}, hydrated: true });
  });

  it('opens the add-person dialog in place from the empty-state invitation', async () => {
    useProfilesStore.setState({ profiles: { [ANCHOR.id]: ANCHOR } }); // anchor alone — no members
    renderMesh();
    expect(screen.getByTestId('mesh-invitation')).toBeTruthy();
    // The hint says what happens next — it no longer points at Settings.
    expect(screen.getByText(/enter their birth details next/i)).toBeTruthy();

    fireEvent.click(screen.getByTestId('mesh-invitation-cta'));

    // The dialog opens right here — no detour to Settings → People.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Amma' } });
    fireEvent.change(screen.getByLabelText('Relationship to you'), {
      target: { value: 'mother' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add & enter birth details' }));

    // Routed through the EXISTING flow once the person is saved: new person
    // active, sent to onboarding.
    expect(await screen.findByTestId('onboarding-stub')).toBeTruthy();
    const created = useProfilesStore
      .getState()
      .listProfiles()
      .find((p) => p.name === 'Amma');
    expect(created).toBeDefined();
    expect(created?.relationship).toBe('mother');
    expect(created?.relatedTo).toBe(ANCHOR.id);
    expect(useProfilesStore.getState().activeProfileId).toBe(created?.id);
  });

  it('the invitation routes to Settings → People, where "this is me" lives', () => {
    // The live-repro shape: a member exists but nobody is marked "this is me".
    // The invitation's body instructs marking "this is me" — the control lives
    // in Settings → People, so the invitation must link there.
    useProfilesStore.setState({ profiles: { [FRIEND.id]: FRIEND } });
    renderMesh();
    expect(screen.getByTestId('mesh-invitation')).toBeTruthy();

    fireEvent.click(screen.getByTestId('mesh-invitation-manage-link'));
    expect(screen.getByTestId('people-stub')).toBeTruthy();
  });

  it('lights a new star in place: the constellation add node opens the same dialog', async () => {
    useProfilesStore.setState({
      profiles: { [ANCHOR.id]: ANCHOR, [SPOUSE.id]: SPOUSE },
      activeProfileId: ANCHOR.id,
    });
    useChartLibraryStore.setState({
      charts: {
        'chart-p-anchor': chartFor(ANCHOR.id, 'Aquarius'),
        'chart-p-spouse': chartFor(SPOUSE.id, 'Leo'),
      },
      hydrated: true,
    });
    renderMesh();

    // The secondary management path survives in the footer.
    expect(screen.getByTestId('mesh-manage-link')).toBeTruthy();

    fireEvent.click(screen.getByTestId('mesh-node-add'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mira Sen' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add & enter birth details' }));

    expect(await screen.findByTestId('onboarding-stub')).toBeTruthy();
    const created = useProfilesStore
      .getState()
      .listProfiles()
      .find((p) => p.name === 'Mira Sen');
    expect(created).toBeDefined();
    expect(useProfilesStore.getState().activeProfileId).toBe(created?.id);
  });

  it('renders the constellation: anchor centred, members named with relationship and rising sign', () => {
    useProfilesStore.setState({
      profiles: { [ANCHOR.id]: ANCHOR, [SPOUSE.id]: SPOUSE, [FRIEND.id]: FRIEND },
      activeProfileId: ANCHOR.id,
    });
    useChartLibraryStore.setState({
      charts: {
        'chart-p-anchor': chartFor(ANCHOR.id, 'Aquarius'),
        'chart-p-spouse': chartFor(SPOUSE.id, 'Leo'),
      },
      hydrated: true,
    });
    renderMesh();

    expect(screen.getByTestId('mesh-page')).toBeTruthy();
    expect(screen.getByTestId('mesh-anchor-node').textContent).toContain('Asha Rao');
    expect(screen.getByTestId('mesh-anchor-node').textContent).toContain('You');

    // Charted member: a real link node with relationship + engine rising sign.
    const spouseNode = screen.getByTestId('mesh-node-p-spouse');
    expect(spouseNode.textContent).toContain('Dev Rao');
    expect(spouseNode.textContent).toContain('Spouse');
    expect(spouseNode.textContent).toContain('Leo rising');

    // Hairline threads exist for every member.
    expect(screen.getByTestId('mesh-thread-p-spouse')).toBeTruthy();
    expect(screen.getByTestId('mesh-thread-p-friend')).toBeTruthy();
  });

  it('opens the edge view when a charted member node is clicked', () => {
    useProfilesStore.setState({
      profiles: { [ANCHOR.id]: ANCHOR, [SPOUSE.id]: SPOUSE },
      activeProfileId: ANCHOR.id,
    });
    useChartLibraryStore.setState({
      charts: {
        'chart-p-anchor': chartFor(ANCHOR.id, 'Aquarius'),
        'chart-p-spouse': chartFor(SPOUSE.id, 'Leo'),
      },
      hydrated: true,
    });
    renderMesh();
    fireEvent.click(screen.getByTestId('mesh-node-p-spouse'));
    expect(screen.getByTestId('edge-stub')).toBeTruthy();
  });

  it('renders a chartless member muted with a generate affordance that onboards them', () => {
    useProfilesStore.setState({
      profiles: { [ANCHOR.id]: ANCHOR, [FRIEND.id]: FRIEND },
      activeProfileId: ANCHOR.id,
    });
    useChartLibraryStore.setState({
      charts: { 'chart-p-anchor': chartFor(ANCHOR.id, 'Aquarius') },
      hydrated: true,
    });
    renderMesh();

    const generateNode = screen.getByTestId('mesh-node-generate-p-friend');
    expect(generateNode.textContent).toContain('No chart yet');
    fireEvent.click(generateNode);

    // The established flow: the person becomes active and lands in onboarding.
    expect(useProfilesStore.getState().activeProfileId).toBe(FRIEND.id);
    expect(screen.getByTestId('onboarding-stub')).toBeTruthy();
  });
});
