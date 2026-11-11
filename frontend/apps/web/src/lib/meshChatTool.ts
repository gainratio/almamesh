/**
 * `read_mesh_member` tool: reads anonymized relationship synastry (`MeshEdge`)
 * from `useProfilesStore` + `useMeshStore`, sanitized through
 * `sanitizeMeshEdgeForLlm` so personal names, member IDs, exact birth dates,
 * and coordinates NEVER reach the LLM.
 */
import { sanitizeMeshEdgeForLlm, type SanitizedMeshEdge } from '@almamesh/llm';
import { defineTool, z, type ToolContext, type ToolDef } from '@almamesh/llm/toolLoop';
import type { MemberRelationship } from '@almamesh/shared-types';
import {
  anchorProfileOf,
  listMembersOf,
  pairKeyOf,
  useChartLibraryStore,
  useMeshStore,
  useProfilesStore,
  type Profile,
} from '@almamesh/store';

import type { ChartEngineContextValue } from '../providers/chartEngineContext';
import { DEFAULT_MESH_WINDOW_YEARS, hasBirthChart, meshEdgeWindow } from './mesh';
import { readyEngine } from './periodChart';
import { predictiveReferenceInstant } from './predictive';

export const READ_MESH_MEMBER_TOOL_NAME = 'read_mesh_member';
const READ_MESH_MEMBER_TIMEOUT_MS = 60_000;
const READ_MESH_MEMBER_STATUS_LABEL = 'Reading relationship synastry…';

const MESH_QUERY_ROLES = [
  'spouse',
  'partner',
  'parent',
  'mother',
  'father',
  'child',
  'sibling',
  'friend',
  'business',
] as const;
type MeshQueryRole = (typeof MESH_QUERY_ROLES)[number];

export interface ReadMeshMemberArgs {
  readonly relationship: MeshQueryRole | null;
  readonly member_index: number | null;
}

interface AnonymizedMemberSlot {
  readonly relationship: MemberRelationship;
  readonly member_index: number;
  readonly role_label: string;
  readonly has_chart: boolean;
}

type ReadMeshMemberResult =
  | { readonly status: 'empty_mesh'; readonly setup_hint: '/mesh' }
  | { readonly status: 'select_member'; readonly available_members: readonly AnonymizedMemberSlot[] }
  | { readonly status: 'needs_member_chart'; readonly role_label: string; readonly setup_hint: '/mesh' }
  | { readonly status: 'unavailable'; readonly reason: string }
  | ({ readonly status: 'ready'; readonly role_label: string } & SanitizedMeshEdge);

export interface MeshChatToolInput {
  readonly engine: ChartEngineContextValue | null;
  readonly viewerZone: () => string;
}

const ARGS_SCHEMA: z.ZodType<ReadMeshMemberArgs> = z
  .object({
    relationship: z
      .enum(MESH_QUERY_ROLES)
      .nullable()
      .describe('Relationship role to inspect ("spouse", "partner", "parent", "mother", "father", "child", "sibling", "friend", "business"), or null to list/auto-pick when only one member exists.'),
    member_index: z
      .number()
      .int()
      .min(1)
      .max(20)
      .nullable()
      .describe('1-based index when multiple members share the same relationship (e.g. friend #1 vs friend #2), or null for the first.'),
  })
  .strict();

const DESCRIPTION = [
  'Read anonymized AlmaMesh relationship synastry (Ashtakoota /36 gunas, doshas & cancellations, Mangal screening, chart overlays, and mutual Dasha synchrony).',
  'Never exposes personal names, birth dates, or coordinates. If no members exist yet, returns status="empty_mesh" with setup_hint="/mesh".',
].join(' ');

function isMemberRel(rel: Profile['relationship']): rel is MemberRelationship {
  return rel !== undefined && rel !== 'self';
}

function roleMatches(memberRel: MemberRelationship, query: MeshQueryRole): boolean {
  if (query === 'parent') return memberRel === 'mother' || memberRel === 'father';
  return memberRel === query;
}

function anonymizeMembers(members: readonly Profile[], charts: ReturnType<typeof useChartLibraryStore.getState>['charts']): AnonymizedMemberSlot[] {
  const counts = new Map<MemberRelationship, number>();
  const totals = new Map<MemberRelationship, number>();
  for (const m of members) {
    if (isMemberRel(m.relationship)) totals.set(m.relationship, (totals.get(m.relationship) ?? 0) + 1);
  }
  return members.flatMap((m) => {
    if (!isMemberRel(m.relationship)) return [];
    const idx = (counts.get(m.relationship) ?? 0) + 1;
    counts.set(m.relationship, idx);
    const total = totals.get(m.relationship) ?? 1;
    const role_label = total > 1 ? `${m.relationship} #${idx}` : m.relationship;
    return [{ relationship: m.relationship, member_index: idx, role_label, has_chart: hasBirthChart(charts, m.id) }];
  });
}

export function createReadMeshMemberTool(input: MeshChatToolInput): ToolDef<ReadMeshMemberArgs> {
  return defineTool({
    name: READ_MESH_MEMBER_TOOL_NAME,
    description: DESCRIPTION,
    input: ARGS_SCHEMA,
    timeoutMs: READ_MESH_MEMBER_TIMEOUT_MS,
    statusLabel: READ_MESH_MEMBER_STATUS_LABEL,
    reads: true,
    execute: async (args, context: ToolContext): Promise<ReadMeshMemberResult> => {
      const profiles = useProfilesStore.getState().profiles;
      const anchor = anchorProfileOf(profiles);
      const members = listMembersOf(profiles);
      if (!anchor || members.length === 0) {
        return { status: 'empty_mesh', setup_hint: '/mesh' };
      }
      const charts = useChartLibraryStore.getState().charts;
      const slots = anonymizeMembers(members, charts);
      if (args.relationship === null) {
        if (members.length > 1) return { status: 'select_member', available_members: slots };
      }
      const matching = args.relationship === null
        ? members.map((m, i) => ({ member: m, slot: slots[i]! }))
        : members
            .map((m, i) => ({ member: m, slot: slots[i]! }))
            .filter(({ member }) => isMemberRel(member.relationship) && roleMatches(member.relationship, args.relationship!));
      if (matching.length === 0) return { status: 'select_member', available_members: slots };
      const targetIndex = (args.member_index ?? 1) - 1;
      const chosen = matching[targetIndex] ?? matching[0]!;
      if (!chosen.slot.has_chart || !hasBirthChart(charts, anchor.id)) {
        return { status: 'needs_member_chart', role_label: chosen.slot.role_label, setup_hint: '/mesh' };
      }
      const pairKey = pairKeyOf(anchor.id, chosen.member.id);
      let entry = useMeshStore.getState().edges[pairKey];
      if (!entry?.edge) {
        try {
          const runtime = await readyEngine(input.engine);
          context.signal.throwIfAborted();
          const refInstant = predictiveReferenceInstant(context.now, input.viewerZone());
          const window = meshEdgeWindow(refInstant, DEFAULT_MESH_WINDOW_YEARS, 'anchor');
          await useMeshStore.getState().ensureMeshEdge(runtime, anchor, chosen.member, window);
          entry = useMeshStore.getState().edges[pairKey];
        } catch (error) {
          if (context.signal.aborted) throw error;
          return { status: 'unavailable', reason: 'engine_unavailable' };
        }
      }
      if (!entry?.edge) return { status: 'unavailable', reason: entry?.error ?? 'edge_unavailable' };
      return {
        status: 'ready',
        role_label: chosen.slot.role_label,
        ...sanitizeMeshEdgeForLlm(entry.edge),
      };
    },
  });
}
