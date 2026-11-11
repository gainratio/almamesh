import {
  pairKeyOf,
  useChartLibraryStore,
  useMeshStore,
  useProfilesStore,
  type Profile,
  type StoredChart,
} from '@almamesh/store';
import { beforeEach, describe, expect, it } from 'vitest';

import { MESH_EDGE_FRIEND, MESH_EDGE_SPOUSE } from '../../test/meshFixtures';
import { createReadMeshMemberTool } from '../meshChatTool';

const CTX = { now: new Date('2026-11-11T18:00:00Z'), signal: new AbortController().signal };

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

const FRIEND_1: Profile = {
  id: 'p-friend-1',
  name: 'Mira Sen',
  createdAt: '2026-01-03T00:00:00Z',
  avatarTint: '#7A4FB0',
  relationship: 'friend',
  relatedTo: 'p-anchor',
};

const FRIEND_2: Profile = {
  id: 'p-friend-2',
  name: 'Rohan Mehta',
  createdAt: '2026-01-04T00:00:00Z',
  avatarTint: '#2A7B6F',
  relationship: 'friend',
  relatedTo: 'p-anchor',
};

const MOTHER: Profile = {
  id: 'p-mother',
  name: 'Kavita Rao',
  createdAt: '2026-01-05T00:00:00Z',
  avatarTint: '#B07A3A',
  relationship: 'mother',
  relatedTo: 'p-anchor',
};

function stubStoredChart(profileId: string): StoredChart {
  return {
    chart_id: `chart-${profileId}`,
    profile_id: profileId,
    birth_data: {
      birth_datetime_utc: '1990-01-15T12:00:00Z',
      birth_location_details: { city: 'Delhi', latitude: 28.6139, longitude: 77.209, timezone: 'Asia/Kolkata' },
    },
  } as unknown as StoredChart;
}

beforeEach(() => {
  useProfilesStore.setState({ profiles: {}, activeProfileId: null });
  useChartLibraryStore.setState({ charts: {} });
  useMeshStore.setState({ edges: {} });
});

describe('read_mesh_member tool', () => {
  it('returns empty_mesh with /mesh setup hint when no members exist', async () => {
    useProfilesStore.setState({ profiles: { [ANCHOR.id]: ANCHOR }, activeProfileId: ANCHOR.id });
    const tool = createReadMeshMemberTool({ engine: null, viewerZone: () => 'America/Los_Angeles' });

    const result = await tool.execute({ relationship: 'spouse', member_index: null }, CTX);
    expect(result).toEqual({ status: 'empty_mesh', setup_hint: '/mesh' });
  });

  it('lists role-indexed anonymized slots without leaking personal names or member IDs', async () => {
    useProfilesStore.setState({
      profiles: {
        [ANCHOR.id]: ANCHOR,
        [SPOUSE.id]: SPOUSE,
        [FRIEND_1.id]: FRIEND_1,
        [FRIEND_2.id]: FRIEND_2,
      },
      activeProfileId: ANCHOR.id,
    });
    useChartLibraryStore.setState({
      charts: {
        c1: stubStoredChart(ANCHOR.id),
        c2: stubStoredChart(SPOUSE.id),
        c3: stubStoredChart(FRIEND_1.id),
      },
    });
    const tool = createReadMeshMemberTool({ engine: null, viewerZone: () => 'America/Los_Angeles' });

    const result = await tool.execute({ relationship: null, member_index: null }, CTX);
    expect(result).toEqual({
      status: 'select_member',
      available_members: [
        { relationship: 'spouse', member_index: 1, role_label: 'spouse', has_chart: true },
        { relationship: 'friend', member_index: 1, role_label: 'friend #1', has_chart: true },
        { relationship: 'friend', member_index: 2, role_label: 'friend #2', has_chart: false },
      ],
    });
    const wire = JSON.stringify(result);
    for (const secret of ['Asha', 'Dev', 'Mira', 'Rohan', 'p-spouse', 'p-friend', '28.6139', '1990-01-15']) {
      expect(wire).not.toContain(secret);
    }
  });

  it('returns sanitized synastry edge for spouse and matches parent -> mother without leaking names', async () => {
    useProfilesStore.setState({
      profiles: { [ANCHOR.id]: ANCHOR, [SPOUSE.id]: SPOUSE, [MOTHER.id]: MOTHER },
      activeProfileId: ANCHOR.id,
    });
    useChartLibraryStore.setState({
      charts: {
        c1: stubStoredChart(ANCHOR.id),
        c2: stubStoredChart(SPOUSE.id),
        c3: stubStoredChart(MOTHER.id),
      },
    });
    useMeshStore.setState({
      edges: {
        [pairKeyOf(ANCHOR.id, SPOUSE.id)]: { status: 'ready', edge: MESH_EDGE_SPOUSE, error: null, computedAt: '2026-11-11T00:00:00Z' },
        [pairKeyOf(ANCHOR.id, MOTHER.id)]: { status: 'ready', edge: MESH_EDGE_FRIEND, error: null, computedAt: '2026-11-11T00:00:00Z' },
      } as unknown as ReturnType<typeof useMeshStore.getState>['edges'],
    });
    const tool = createReadMeshMemberTool({ engine: null, viewerZone: () => 'America/Los_Angeles' });

    const spouseRes = await tool.execute({ relationship: 'spouse', member_index: null }, CTX);
    expect(spouseRes).toMatchObject({ status: 'ready', role_label: 'spouse', relationship: 'spouse' });
    expect(JSON.stringify(spouseRes)).not.toContain('Dev Rao');
    expect(JSON.stringify(spouseRes)).not.toContain('Asha Rao');

    const parentRes = await tool.execute({ relationship: 'parent', member_index: null }, CTX);
    expect(parentRes).toMatchObject({ status: 'ready', role_label: 'mother' });
    expect(JSON.stringify(parentRes)).not.toContain('Kavita Rao');
  });
});
