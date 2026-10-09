/**
 * MeshEdgePage — `/mesh/:memberId`, the relationship edge view.
 *
 * The engine is absent in these tests (no runtime provider), so the page's
 * `ensureMeshEdge` effect is a no-op and every state is seeded directly into
 * `useMeshStore` — exactly the store contract the live engine drives. Asserts
 * the relationship CURATION rule (marriage tables only for spouse/partner),
 * verbatim engine numbers, honest pending/error states, and the integrity foot.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  pairKeyOf,
  useChartLibraryStore,
  useLanguageStore,
  useMeshStore,
  useProfilesStore,
  type Profile,
  type StoredChart,
} from '@almamesh/store';
import type { MeshEdgeCtx } from '@almamesh/shared-types';
import { openRouterPreset, writeLlmSettings } from '@almamesh/llm';

import '../../i18n/config';
import MeshEdgePage from '../MeshEdge';
import { buildChatToolset, type ChatToolset } from '../../lib/chatToolset';
import { expectToolsetReadsViewerToday } from '../../test/viewerToday';
import { MESH_EDGE_FRIEND, MESH_EDGE_SPOUSE } from '../../test/meshFixtures';
import { __resetMemoryForTest, __setMemoryForTest } from '../../lib/chatMemory';

const llmMocks = vi.hoisted(() => ({
  streamAgentChat: vi.fn(),
  streamChartChat: vi.fn(),
}));

vi.mock('@almamesh/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@almamesh/llm')>();
  return {
    ...actual,
    streamAgentChat: llmMocks.streamAgentChat,
    streamChartChat: llmMocks.streamChartChat,
  };
});

vi.mock('../../lib/chatToolset', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/chatToolset')>();
  return { ...actual, buildChatToolset: vi.fn(actual.buildChatToolset) };
});

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

function chartFor(profileId: string): StoredChart {
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
      sidereal_ctx: { lagna: { sign: 'Aquarius', longitude: 328.84 } },
      calculation_timestamp: '2026-01-01T12:00:00.000Z',
    },
    sidereal_chart: {
      ayanamsa_value: 23.86,
      lagna: { sign: 'Aquarius', sign_degrees: 28.84 },
      planets: {},
      houses: {},
      yogas: [],
    },
  } as unknown as StoredChart;
}

function seedPeople(member: Profile): void {
  useProfilesStore.setState({
    profiles: { [ANCHOR.id]: ANCHOR, [member.id]: member },
    activeProfileId: ANCHOR.id,
    hydrated: true,
  });
}

function seedCharts(member: Profile): void {
  useChartLibraryStore.setState({
    charts: {
      [`chart-${ANCHOR.id}`]: chartFor(ANCHOR.id),
      [`chart-${member.id}`]: chartFor(member.id),
    },
    hydrated: true,
  });
}

function seedEdge(member: Profile, edge: MeshEdgeCtx): void {
  useMeshStore.setState({
    edges: {
      [pairKeyOf(ANCHOR.id, member.id)]: { status: 'ready', edge, requestKey: 'seeded' },
    },
  });
}

function renderAt(path: string): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/mesh" element={<div data-testid="mesh-stub" />} />
          <Route path="/mesh/:memberId" element={<MeshEdgePage />} />
          <Route path="/onboarding" element={<div data-testid="onboarding-stub" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('MeshEdgePage', () => {
  beforeEach(() => {
    localStorage.clear();
    llmMocks.streamAgentChat.mockReset();
    llmMocks.streamChartChat.mockReset();
    useLanguageStore.setState({ language: 'en' });
    useProfilesStore.setState({ profiles: {}, activeProfileId: null, hydrated: true });
    useChartLibraryStore.setState({ charts: {}, hydrated: true });
    useMeshStore.getState().reset();
  });

  afterEach(() => {
    __resetMemoryForTest();
    localStorage.clear();
  });

  it('redirects an unknown or relationship-less member back to the mesh', () => {
    seedPeople(SPOUSE);
    renderAt('/mesh/nobody');
    expect(screen.getByTestId('mesh-stub')).toBeTruthy();
    expect(screen.queryByTestId('mesh-edge-page')).toBeNull();
  });

  it('gates honestly when the member has no generated chart, offering the onboarding flow', () => {
    seedPeople(FRIEND);
    useChartLibraryStore.setState({
      charts: { [`chart-${ANCHOR.id}`]: chartFor(ANCHOR.id) },
      hydrated: true,
    });
    renderAt('/mesh/p-friend');

    expect(screen.getByTestId('mesh-edge-needs-chart')).toBeTruthy();
    fireEvent.click(screen.getByTestId('mesh-edge-generate-p-friend'));
    expect(useProfilesStore.getState().activeProfileId).toBe(FRIEND.id);
    expect(screen.getByTestId('onboarding-stub')).toBeTruthy();
  });

  it('shows the honest seconds-scale pending state while the edge is loading', () => {
    seedPeople(SPOUSE);
    seedCharts(SPOUSE);
    useMeshStore.setState({
      edges: { [pairKeyOf(ANCHOR.id, SPOUSE.id)]: { status: 'loading', requestKey: 'k' } },
    });
    renderAt('/mesh/p-spouse');
    expect(screen.getByTestId('mesh-edge-pending')).toBeTruthy();
  });

  it('surfaces an engine failure with a retry affordance', () => {
    seedPeople(SPOUSE);
    seedCharts(SPOUSE);
    useMeshStore.setState({
      edges: {
        [pairKeyOf(ANCHOR.id, SPOUSE.id)]: {
          status: 'error',
          error: 'role_a and role_b must differ',
          requestKey: 'k',
        },
      },
    });
    renderAt('/mesh/p-spouse');
    expect(screen.getByTestId('mesh-edge-error').textContent).toContain(
      'role_a and role_b must differ',
    );
    expect(screen.getByTestId('mesh-edge-retry')).toBeTruthy();
  });

  it('renders the full spouse edge: marriage tables, both overlays, synchrony, corroboration, integrity', () => {
    seedPeople(SPOUSE);
    seedCharts(SPOUSE);
    seedEdge(SPOUSE, MESH_EDGE_SPOUSE);
    const { container } = renderAt('/mesh/p-spouse');

    // Compatibility — 8 koota rows, verbatim total, convention-labeled band.
    expect(screen.getByTestId('mesh-compatibility')).toBeTruthy();
    expect(container.querySelectorAll('[data-testid^="mesh-koota-"]')).toHaveLength(8);
    expect(screen.getByTestId('mesh-guna-total').textContent).toContain('24.5');
    expect(screen.getByTestId('mesh-guna-total').textContent).toContain('Good');
    expect(screen.getByTestId('mesh-guna-total').textContent).toContain(
      'a label, not a verdict',
    );

    // Doshas in calm words with cancellation status.
    expect(screen.getByTestId('mesh-dosha-bhakoot_dosha').textContent).toContain(
      'present — cancelled',
    );
    expect(screen.getByTestId('mesh-dosha-nadi_dosha').textContent).toContain('not present');

    // Role seat: plain-language, both seats addressable.
    expect(screen.getByTestId('mesh-role-anchor').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('mesh-role-member'));
    expect(screen.getByTestId('mesh-role-member').getAttribute('aria-pressed')).toBe('true');

    // Mangal — both charts + the mutual cancellation line.
    expect(screen.getByTestId('mesh-mangal')).toBeTruthy();
    expect(screen.getByTestId('mesh-mangal-mutual')).toBeTruthy();

    // Connection — both directions, orb shown, heuristic footnote names the convention.
    expect(screen.getByTestId('mesh-overlay-b-in-a').textContent).toContain('2.1° orb');
    expect(screen.getByTestId('mesh-overlay-a-in-b')).toBeTruthy();
    expect(screen.getByTestId('mesh-heuristic-note').textContent).toContain('whole-sign');

    // Synchrony — both tracks per segment, the shared-lord window highlighted.
    expect(screen.getAllByTestId('mesh-synchrony-segment')).toHaveLength(2);
    expect(screen.getByTestId('mesh-shared-window').textContent).toContain('Venus');
    expect(screen.getByTestId('mesh-synchrony').textContent).toContain('Gregorian year');

    // Corroboration — your 7th and its lord next to theirs.
    expect(screen.getByTestId('mesh-significators-anchor').textContent).toContain('House 7 — Leo');
    expect(screen.getByTestId('mesh-significators-member').textContent).toContain(
      'House 7 — Aquarius',
    );
    expect(screen.getByTestId('mesh-significators-member').textContent).toContain('retrograde');

    // AI is unconfigured in tests → the honest CTA, never a spinner.
    expect(screen.getByTestId('mesh-reading-cta')).toBeTruthy();
    expect(screen.queryByTestId('mesh-discuss-chat')).toBeNull();

    // The engine's read-only promise, verbatim, at the foot.
    expect(screen.getByTestId('mesh-integrity-note').textContent).toContain(
      'neither chart is recomputed',
    );
  });

  it('curates by relationship: a friend edge leads with Graha Maitri and hides the marriage tables', () => {
    seedPeople(FRIEND);
    seedCharts(FRIEND);
    seedEdge(FRIEND, MESH_EDGE_FRIEND);
    renderAt('/mesh/p-friend');

    expect(screen.queryByTestId('mesh-compatibility')).toBeNull();
    expect(screen.queryByTestId('mesh-mangal')).toBeNull();
    const maitri = screen.getByTestId('mesh-maitri');
    expect(maitri.textContent).toContain('Graha Maitri');
    expect(maitri.textContent).toContain('4');

    // The shared, relationship-agnostic sections still render.
    expect(screen.getByTestId('mesh-connection')).toBeTruthy();
    expect(screen.getByTestId('mesh-synchrony')).toBeTruthy();
    expect(screen.getByTestId('mesh-significators-anchor').textContent).toContain('House 11');
  });

  it('offers the synchrony window control with the 2-year default selected', () => {
    seedPeople(SPOUSE);
    seedCharts(SPOUSE);
    seedEdge(SPOUSE, MESH_EDGE_SPOUSE);
    renderAt('/mesh/p-spouse');

    expect(screen.getByTestId('mesh-window-2y').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('mesh-window-5y'));
    expect(screen.getByTestId('mesh-window-5y').getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps relationship chat inside the bounded agent loop with sanitized mesh grounding', async () => {
    writeLlmSettings(openRouterPreset('sk-or-v1-0000-synthetic-test-key', 'test-org/test-model'));
    __setMemoryForTest({
      indexMessage: vi.fn().mockResolvedValue(undefined),
      retrieve: vi.fn().mockResolvedValue([]),
      deleteForProfile: vi.fn().mockResolvedValue(undefined),
      deleteForThread: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    });
    llmMocks.streamAgentChat.mockImplementation(async function* (options) {
      options.onStatus?.({ phase: 'deciding', round: 1 });
      options.onStatus?.({ phase: 'answering' });
      yield 'The relationship timing is grounded in both charts.';
      options.onStatus?.({ phase: 'complete' });
    });

    seedPeople(SPOUSE);
    seedCharts(SPOUSE);
    seedEdge(SPOUSE, MESH_EDGE_SPOUSE);
    renderAt('/mesh/p-spouse');

    fireEvent.click(screen.getByTestId('mesh-discuss-chat'));
    fireEvent.change(await screen.findByTestId('chat-input'), {
      target: { value: 'How are our charts working together?' },
    });
    fireEvent.click(screen.getByTestId('chat-send-button'));

    await waitFor(() => expect(llmMocks.streamAgentChat).toHaveBeenCalledTimes(1));
    expect(llmMocks.streamChartChat).not.toHaveBeenCalled();
    const options = llmMocks.streamAgentChat.mock.calls[0][0];
    expect(options.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'get_current_datetime',
      'get_chart_facts',
      'get_timing',
    ]);
    expect(JSON.stringify(options.messages)).toContain('ENGINE RELATIONSHIP CONTEXT');
    expect(JSON.stringify(options.messages)).not.toContain(ANCHOR.name);
    expect(JSON.stringify(options.messages)).not.toContain(SPOUSE.name);
    await waitFor(() =>
      expect(screen.getByTestId('chat-panel').textContent).toContain(
        'relationship timing is grounded',
      ),
    );
    // Same function of the same instant as the Dashboard pin: a page that reads
    // its birth zone for "today" fails here.
    const toolset = vi.mocked(buildChatToolset).mock.results.at(-1)!.value as ChatToolset;
    await expectToolsetReadsViewerToday(toolset, 'Asia/Kolkata'); // the anchor's birth zone in this fixture
  });
  it('refuses relationship chat when the anchor chart has no birthplace timezone (no silent UTC)', async () => {
    writeLlmSettings(openRouterPreset('sk-or-v1-0000-synthetic-test-key', 'test-org/test-model'));
    __setMemoryForTest({
      indexMessage: vi.fn().mockResolvedValue(undefined),
      retrieve: vi.fn().mockResolvedValue([]),
      deleteForProfile: vi.fn().mockResolvedValue(undefined),
      deleteForThread: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    });
    seedPeople(SPOUSE);
    seedCharts(SPOUSE);
    const anchor = chartFor(ANCHOR.id);
    const details = anchor.birth_data!.birth_location_details;
    useChartLibraryStore.setState((state) => ({
      charts: {
        ...state.charts,
        [`chart-${ANCHOR.id}`]: {
          ...anchor,
          birth_data: { ...anchor.birth_data!, birth_location_details: { ...details, timezone: '' } },
        },
      },
    }));
    seedEdge(SPOUSE, MESH_EDGE_SPOUSE);
    renderAt('/mesh/p-spouse');

    fireEvent.click(screen.getByTestId('mesh-discuss-chat'));
    fireEvent.change(await screen.findByTestId('chat-input'), {
      target: { value: 'How are our charts working together?' },
    });
    fireEvent.click(screen.getByTestId('chat-send-button'));

    // The send fails visibly (the chat's generic error card) and nothing is
    // sent: no model ever answers "what time is it" in a guessed UTC.
    await waitFor(() =>
      expect(screen.getByTestId('chat-panel').textContent).toMatch(/couldn't process your request/),
    );
    expect(llmMocks.streamAgentChat).not.toHaveBeenCalled();
  });
});
