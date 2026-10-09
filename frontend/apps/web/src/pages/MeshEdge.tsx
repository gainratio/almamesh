/**
 * MeshEdgePage — `/mesh/:memberId`, one relationship read between two whole
 * charts: the anchor's ("you") and a member's.
 *
 * On mount it drives the idempotent `ensureMeshEdge` (on-device, seconds — two
 * natal contexts + relation math, honestly timed while pending). The sections
 * are CURATED BY RELATIONSHIP: Ashtakoota + Mangal are marriage tables and
 * render only for spouse/partner edges (with an explicit role-seat control);
 * family/friend/business edges lead with Graha Maitri. Then, for every edge:
 * the two-way overlay, the daśā synchrony timeline (window now → +2y by
 * default), the side-by-side significator corroboration, the optional AI
 * reading, and — at the foot — the engine's own integrity note, verbatim.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import {
  IDLE_MESH_EDGE,
  pairKeyOf,
  useAnchorProfile,
  useChartLibraryStore,
  useContentModeStore,
  useLanguageStore,
  useMeshStore,
  useProfilesStore,
  requireBirthTimeZone,
  type MeshEdgeEntry,
  type Profile,
} from '@almamesh/store';
import type {
  MemberRelationship,
  MeshEdgeCtx,
  ProcessedBirthData,
  ChatThreadAsOf,
} from '@almamesh/shared-types';
import {
  applyChatSettings,
  buildChatMessages,
  describeLlmStatus,
  resolveProviderConfig,
  sanitizeChartForLlm,
  sanitizeMeshEdgeForLlm,
  streamAgentChat,
  type AgentStatusEvent,
  type ChatTurn,
  type LlmEnv,
} from '@almamesh/llm';

import { Button, Card, Spinner } from '../components/ui';
import { ContentModeToggle } from '../components/ui/ContentModeToggle';
import { FloatingChatPanel } from '../components/features/chat/FloatingChatPanel';
import {
  CompatibilitySection,
  ConnectionSection,
  GrahaMaitriLead,
  MeshReadingSection,
  SignificatorsSection,
  SynchronySection,
} from '../components/features/mesh';
import { useElapsedSeconds, formatElapsed } from '../hooks/useElapsedSeconds';
import type { MeshReadingContext } from '../hooks/useMeshReading';
import { isMappedChatStreamError } from '../hooks/useChatThread';
import { useOptionalChartEngine } from '../providers/chartEngineContext';
import { getUserFriendlyError } from '../lib/errors';
import {
  DEFAULT_MESH_WINDOW_YEARS,
  hasBirthChart,
  isMarriageEdge,
  meshEdgeWindow,
  profileChartOf,
  type BrideTableSide,
  type MeshWindowYears,
} from '../lib/mesh';
import { predictiveReferenceInstant } from '../lib/predictive';
import { buildChatToolset } from '../lib/chatToolset';
import { formatPinLabel } from '../lib/timeTravelSheet';
import { birthYearOf } from '../lib/periodChart';
import { RESOLVE_PLACE_TOOL_NAME } from '../lib/placeTool';
import type { SSEMetaData } from '../lib/streaming';
import type { ViewMode } from '../lib/types';
import { storedChartAnalysisInstant } from '../lib/analysisInstant';

/** The chat-tuned provider env (mirrors the dashboard's chat wiring): the
 * EXPLICIT chat model via applyChatSettings (replaces the silent swap). */
function readMeshChatEnv(): LlmEnv {
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  return applyChatSettings({
    VITE_LLM_API_BASE: env.VITE_LLM_API_BASE,
    VITE_LLM_API_KEY: env.VITE_LLM_API_KEY,
    VITE_LLM_MODEL: env.VITE_LLM_MODEL,
    VITE_LLM_PRIVACY_MODE: env.VITE_LLM_PRIVACY_MODE,
    VITE_LLM_ENGINE: env.VITE_LLM_ENGINE,
  });
}

/** One or both people have no generated chart — the honest gate, with exits. */
function NeedsCharts({
  anchor,
  member,
  anchorReady,
  memberReady,
  onGenerateChart,
}: {
  anchor: Profile;
  member: Profile;
  anchorReady: boolean;
  memberReady: boolean;
  onGenerateChart: (profileId: string) => void;
}): ReactElement {
  const { t } = useTranslation('mesh');
  return (
    <Card title={t('edge.needs_charts_title')} data-testid="mesh-edge-needs-chart">
      <div className="space-y-4">
        {!anchorReady && (
          <div className="space-y-2">
            <p className="max-w-prose text-sm leading-relaxed text-text-secondary">
              {t('edge.needs_chart_anchor')}
            </p>
            <Button
              onClick={() => onGenerateChart(anchor.id)}
              data-testid={`mesh-edge-generate-${anchor.id}`}
            >
              {t('edge.generate_yours')}
            </Button>
          </div>
        )}
        {!memberReady && (
          <div className="space-y-2">
            <p className="max-w-prose text-sm leading-relaxed text-text-secondary">
              {t('edge.needs_chart_member', { name: member.name })}
            </p>
            <Button
              onClick={() => onGenerateChart(member.id)}
              data-testid={`mesh-edge-generate-${member.id}`}
            >
              {t('edge.generate_for', { name: member.name })}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

/** Pending: the engine is warming or the edge is being woven (honest timer). */
function EdgePending({ engineReady }: { engineReady: boolean }): ReactElement {
  const { t } = useTranslation(['mesh', 'life']);
  const elapsed = useElapsedSeconds(engineReady);
  return (
    <Card data-testid="mesh-edge-pending">
      <p className="flex items-start gap-3 text-sm leading-relaxed text-text-secondary">
        <Spinner size="sm" className="mt-0.5 shrink-0" />
        <span>
          {engineReady
            ? t('mesh:edge.computing', { elapsed: formatElapsed(elapsed) })
            : t('life:atlas.engine_warming')}
        </span>
      </p>
    </Card>
  );
}

function EdgeError({ error, onRetry }: { error?: string; onRetry: () => void }): ReactElement {
  const { t } = useTranslation('mesh');
  return (
    <Card title={t('edge.error_title')} data-testid="mesh-edge-error">
      <div className="space-y-3">
        {error && <p className="text-sm text-status-error">{error}</p>}
        <Button onClick={onRetry} data-testid="mesh-edge-retry">
          {t('edge.retry')}
        </Button>
      </div>
    </Card>
  );
}

/** The engine's read-only statement, verbatim — the anti-scam promise. */
function IntegrityFoot({ note }: { note: string }): ReactElement {
  const { t } = useTranslation('mesh');
  return (
    <footer
      className="max-w-2xl border-l-2 border-accent-gold/40 pl-4"
      data-testid="mesh-integrity-note"
    >
      <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-text-tertiary">
        {t('edge.integrity_label')}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-text-secondary">{note}</p>
    </footer>
  );
}

/** The ready edge: sections curated by relationship, integrity note last. */
function EdgeSections({
  edge,
  memberName,
  relationship,
  brideSide,
  onBrideSideChange,
  years,
  onYearsChange,
  onDiscuss,
  readingContext,
}: {
  edge: MeshEdgeCtx;
  memberName: string;
  relationship: MemberRelationship;
  brideSide: BrideTableSide;
  onBrideSideChange: (side: BrideTableSide) => void;
  years: MeshWindowYears;
  onYearsChange: (years: MeshWindowYears) => void;
  onDiscuss: () => void;
  readingContext: MeshReadingContext;
}): ReactElement {
  return (
    <div className="space-y-8">
      {isMarriageEdge(relationship) ? (
        <CompatibilitySection
          edge={edge}
          memberName={memberName}
          brideSide={brideSide}
          onBrideSideChange={onBrideSideChange}
        />
      ) : (
        <GrahaMaitriLead edge={edge} memberName={memberName} />
      )}
      <ConnectionSection edge={edge} memberName={memberName} />
      <SynchronySection
        edge={edge}
        memberName={memberName}
        years={years}
        onYearsChange={onYearsChange}
      />
      <SignificatorsSection edge={edge} memberName={memberName} />
      <MeshReadingSection edge={edge} readingContext={readingContext} onDiscuss={onDiscuss} />
      <IntegrityFoot note={edge.integrity_note} />
    </div>
  );
}

function MeshEdgeContent({
  anchor,
  member,
  relationship,
}: {
  anchor: Profile;
  member: Profile;
  relationship: MemberRelationship;
}): ReactElement {
  const { t } = useTranslation(['mesh', 'settings', 'dashboard', 'errors']);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setActiveProfile = useProfilesStore((s) => s.setActiveProfile);
  const charts = useChartLibraryStore((s) => s.charts);
  const chartsHydrated = useChartLibraryStore((s) => s.hydrated);
  const chartEngineContext = useOptionalChartEngine();
  const engine = chartEngineContext?.engine ?? null;
  const contentMode = useContentModeStore((s) => s.contentMode);
  const viewMode: ViewMode = contentMode === 'technical' ? 'astrologer' : 'layman';

  // The explicit window: pinned reference instant, now → +N years, role seats.
  const [years, setYears] = useState<MeshWindowYears>(DEFAULT_MESH_WINDOW_YEARS);
  const [brideSide, setBrideSide] = useState<BrideTableSide>('anchor');
  const referenceInstant = useMemo(() => predictiveReferenceInstant(), []);
  const window = useMemo(
    () => meshEdgeWindow(referenceInstant, years, brideSide),
    [referenceInstant, years, brideSide],
  );

  const anchorReady = hasBirthChart(charts, anchor.id);
  const memberReady = hasBirthChart(charts, member.id);
  const pairKey = pairKeyOf(anchor.id, member.id);
  const entry: MeshEdgeEntry = useMeshStore((s) => s.edges[pairKey]) ?? IDLE_MESH_EDGE;

  // Idempotent per pair+births+window+roles; re-fires on window/seat changes.
  const ensure = useCallback(() => {
    if (engine && anchorReady && memberReady) {
      void useMeshStore.getState().ensureMeshEdge(engine, anchor, member, window);
    }
  }, [engine, anchor, member, window, anchorReady, memberReady]);
  useEffect(() => {
    ensure();
  }, [ensure]);

  // "Discuss in chat": the same persisted, edge-grounded chat panel pattern as
  // the dashboard — remounted open on request via the key flip.
  const [discussRequested, setDiscussRequested] = useState(false);
  const anchorChart = profileChartOf(charts, anchor.id);
  const siderealChart = anchorChart?.sidereal_chart;

  const askMeshLlm = async function* (
    question: string,
    questionViewMode: ViewMode | undefined,
    signal: AbortSignal,
    history: readonly ChatTurn[] = [],
    retrievedContext: readonly string[] = [],
    onAgentStatus?: (label: string | null) => void,
    asOf?: ChatThreadAsOf,
  ): AsyncGenerator<string> {
    if (!siderealChart) {
      throw new Error(t('errors:needs_regeneration'));
    }
    if (!describeLlmStatus().configured) {
      throw new Error(t('dashboard:chat.not_configured_notice'));
    }
    const effectiveViewMode = questionViewMode || viewMode;
    const chatMode = effectiveViewMode === 'astrologer' ? 'expert' : 'layman';
    const config = resolveProviderConfig(readMeshChatEnv());
    const language = useLanguageStore.getState().language;
    // `now` is ONLY for questions genuinely about today. Everything else
    // describes the chart as of its own analysis instant.
    const now = new Date();
    // No `?? 'UTC'`: the chat's "current time in the chart's zone" tool would
    // silently answer in UTC. A chart without a zone is refused, visibly.
    const chartTimeZone = requireBirthTimeZone(
      anchorChart?.birth_data?.birth_location_details.timezone,
      'chat',
    );
    const toolset = buildChatToolset({
      chart: siderealChart,
      chartAsOf: storedChartAnalysisInstant(anchorChart!),
      chartTimeZone,
      profileKey: anchorChart?.profile_id ?? anchorChart?.chart_id ?? anchor.id,
      birth: anchorChart?.birth_data as ProcessedBirthData | undefined,
      engine: chartEngineContext,
      ...(asOf ? { pinned: asOf } : {}),
    });
    const prepared = await toolset.prepare(question, {
      now,
      signal,
      onStatus: (label) => onAgentStatus?.(label),
      pinnedStatus: asOf ? t('chat:time_travel.status_working', { period: formatPinLabel(asOf, language) }) : undefined,
    });

    let messages = buildChatMessages(
      sanitizeChartForLlm(prepared.chart, prepared.asOf),
      question,
      chatMode,
      history,
      retrievedContext,
      undefined,
      language,
      entry.edge ? sanitizeMeshEdgeForLlm(entry.edge) : undefined,
      undefined,
      undefined,
      toolset.tools.some((tool) => tool.name === RESOLVE_PLACE_TOOL_NAME),
      prepared.pinned,
    );
    if (prepared.currentContextUnavailable) {
      const [system, ...rest] = messages;
      messages = [
        {
          ...system,
          content:
            `${system.content ?? ''}\n\n` +
            'CURRENT-CONTEXT SAFETY: This question requires exact-day planetary facts, but the on-device calculation was unavailable. Say that plainly and do not infer current transits or timing from natal or relationship facts.',
        },
        ...rest,
      ];
    }

    let activeToolLabel: string | null = null;
    yield* streamAgentChat({
      config,
      messages,
      tools: toolset.tools,
      now,
      signal,
      onStatus: (event) => {
        if (event.phase === 'using_tool') {
          activeToolLabel = event.label;
        } else if (event.phase === 'deciding' && event.round > 1 && activeToolLabel !== null) {
          return;
        } else if (event.phase === 'answering' || event.phase === 'complete') {
          activeToolLabel = null;
        }
        onAgentStatus?.(agentStatusLabel(event));
      },
    });
  };

  function agentStatusLabel(event: AgentStatusEvent): string {
    switch (event.phase) {
      case 'deciding':
        return t('chat:agent.deciding');
      case 'using_tool':
        return event.label;
      case 'answering':
        return t('chat:agent.answering');
      case 'complete':
        return t('chat:agent.complete');
    }
  }

  const handleAskQuestionStream = async (
    question: string,
    onToken: (token: string) => void,
    _onMeta: (meta: SSEMetaData) => void,
    questionViewMode?: ViewMode,
    history: readonly ChatTurn[] = [],
    retrievedContext: readonly string[] = [],
    onAgentStatus?: (label: string | null) => void,
    asOf?: ChatThreadAsOf,
  ): Promise<{ answer: string; timing_guidance?: string | null; remedies?: string[] | null }> => {
    const controller = new AbortController();
    let answer = '';
    try {
      for await (const delta of askMeshLlm(
        question,
        questionViewMode,
        controller.signal,
        history,
        retrievedContext,
        onAgentStatus,
        asOf,
      )) {
        answer += delta;
        onToken(delta);
      }
    } catch (err) {
      // Typed @almamesh/llm causes (on-device, privacy fence, request/endpoint
      // failures) must reach useChatThread intact so `describeChatStreamError`
      // can give the user an actionable message instead of the generic QA_001.
      if (isMappedChatStreamError(err)) throw err;
      throw new Error(
        getUserFriendlyError(
          'QA_001',
          err instanceof Error ? err.message : undefined,
          t('dashboard:chat.not_configured_notice'),
        ),
        { cause: err },
      );
    }
    return { answer, timing_guidance: null, remedies: null as string[] | null };
  };

  /** Established flow: switch to the chart-less person and onboard them. */
  const handleGenerateChart = (profileId: string): void => {
    setActiveProfile(profileId);
    void queryClient.invalidateQueries({ queryKey: ['primary-chart'] });
    navigate('/onboarding');
  };

  let body: ReactElement;
  if (!chartsHydrated) {
    body = (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  } else if (!anchorReady || !memberReady) {
    body = (
      <NeedsCharts
        anchor={anchor}
        member={member}
        anchorReady={anchorReady}
        memberReady={memberReady}
        onGenerateChart={handleGenerateChart}
      />
    );
  } else if (entry.status === 'error') {
    body = <EdgeError error={entry.error} onRetry={ensure} />;
  } else if (entry.status !== 'ready' || !entry.edge || !entry.requestKey) {
    body = <EdgePending engineReady={engine !== null} />;
  } else {
    body = (
      <EdgeSections
        edge={entry.edge}
        memberName={member.name}
        relationship={relationship}
        brideSide={brideSide}
        onBrideSideChange={setBrideSide}
        years={years}
        onYearsChange={setYears}
        onDiscuss={() => setDiscussRequested(true)}
        readingContext={{
          pairKey,
          profileIds: [anchor.id, member.id],
          edgeRequestKey: entry.requestKey,
        }}
      />
    );
  }

  return (
    <div className="space-y-8" data-testid="mesh-edge-page">
      <nav>
        <Link
          to="/mesh"
          className="inline-flex items-center gap-1.5 text-sm text-text-muted transition-colors hover:text-text-primary"
          data-testid="mesh-edge-back"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          {t('mesh:edge.back')}
        </Link>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4 border-b border-ui-border pb-6">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-text-tertiary">
            {t('mesh:edge.kicker', {
              relationship: t(`settings:people.relationships.${relationship}`),
            })}
          </p>
          <h1 className="mt-1 font-display text-3xl leading-tight text-text-primary">
            {t('mesh:edge.title', { anchor: anchor.name, member: member.name })}
          </h1>
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-text-secondary">
            {t('mesh:edge.frame')}
          </p>
        </div>
        <ContentModeToggle />
      </header>

      {body}

      {siderealChart && (
        <FloatingChatPanel
          key={discussRequested ? 'mesh-chat-open' : 'mesh-chat-closed'}
          personName={anchor.name}
          profileId={anchor.id}
          chartId={anchorChart?.chart_id ?? null}
          viewMode={viewMode}
          onAskQuestionStream={handleAskQuestionStream}
          birthYear={birthYearOf(anchorChart?.birth_data as ProcessedBirthData | undefined)}
          initialOpen={discussRequested}
        />
      )}
    </div>
  );
}

export default function MeshEdgePage(): ReactElement {
  const { memberId } = useParams();
  const hydrated = useProfilesStore((s) => s.hydrated);
  const anchor = useAnchorProfile();
  const member = useProfilesStore((s) => (memberId ? s.profiles[memberId] : undefined));

  if (!hydrated) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }
  const relationship = member?.relationship;
  if (!anchor || !member || relationship === undefined || relationship === 'self') {
    return <Navigate to="/mesh" replace />;
  }
  return <MeshEdgeContent anchor={anchor} member={member} relationship={relationship} />;
}
