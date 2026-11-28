/**
 * useMeshReading — drives `@almamesh/llm`'s three-section mesh edge reading
 * (connection / timing together / care) from the edge view.
 *
 * Mirrors the dashboard's interpretation wiring: the model env comes from the
 * persisted LLM settings via `applyInterpretationSettings` (the explicit
 * interpretation tier — a strong/frontier model; chat keeps its own fast-model
 * tier elsewhere), the narration language follows the UI language store, and the
 * voice mode follows the global content mode. The generation NEVER auto-starts;
 * `generate()` is an explicit human action.
 *
 * Deterministic edges re-derive in seconds. Successfully completed narrations
 * are user-paid artifacts, so they persist in canonical SQLite and are reused
 * only for the exact edge request + language that produced them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useContentModeStore,
  useLanguageStore,
  useMeshReadingsStore,
  type MeshReadingIdentity,
} from '@almamesh/store';
import type { MeshEdgeCtx } from '@almamesh/shared-types';
import {
  applyInterpretationSettings,
  configProvenance,
  resolveProviderConfig,
  streamMeshReading,
  type LlmEnv,
  type MeshEdgeContext as LlmMeshEdgeContext,
  type MeshReading,
  type MeshReadingSectionKey,
} from '@almamesh/llm';
import { chatErrorMessage, classifyConnectionError, privacyBlockedMessage } from '../lib/errors';
import { whenDataLifecycleReady } from '../lib/profileDataLifecycle';

export type MeshReadingStatus = 'idle' | 'streaming' | 'complete' | 'error';

export interface MeshReadingLayer {
  readonly status: MeshReadingStatus;
  readonly reading?: MeshReading;
  readonly error?: string;
  /** Sections that finished (drives the honest per-section checklist). */
  readonly completed: ReadonlySet<MeshReadingSectionKey>;
  /** Sections that failed during a partial run. */
  readonly failed?: ReadonlySet<MeshReadingSectionKey>;
  /** Explicitly start (or restart) the narration. No-op while streaming. */
  readonly generate: () => void;
}

/** The persisted LLM settings as a provider env (interpretation-grade model). */
function readMeshLlmEnv(): LlmEnv {
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  return applyInterpretationSettings({
    VITE_LLM_API_BASE: env.VITE_LLM_API_BASE,
    VITE_LLM_API_KEY: env.VITE_LLM_API_KEY,
    VITE_LLM_MODEL: env.VITE_LLM_MODEL,
    VITE_LLM_PRIVACY_MODE: env.VITE_LLM_PRIVACY_MODE,
    VITE_LLM_ENGINE: env.VITE_LLM_ENGINE,
  });
}

interface ReadingState {
  readonly status: MeshReadingStatus;
  readonly reading?: MeshReading;
  readonly error?: string;
  readonly completed: ReadonlySet<MeshReadingSectionKey>;
  readonly failed: ReadonlySet<MeshReadingSectionKey>;
}

const IDLE_STATE: ReadingState = { status: 'idle', completed: new Set(), failed: new Set() };

export interface MeshReadingContext {
  readonly pairKey: string;
  readonly profileIds: readonly [string, string];
  readonly edgeRequestKey: string;
}

/**
 * The text shown after "The reading failed:". Known provider/privacy failures
 * map to actionable localized copy; unclassified errors keep their message.
 */
function meshReadingErrorText(err: unknown): string {
  const kind = classifyConnectionError(err);
  if (kind === 'privacy') return privacyBlockedMessage(err);
  if (kind !== 'unknown') return chatErrorMessage(err);
  return err instanceof Error ? err.message : String(err);
}

export function useMeshReading(
  edge: MeshEdgeCtx | undefined,
  context: MeshReadingContext | undefined,
): MeshReadingLayer {
  const [state, setState] = useState<ReadingState>(IDLE_STATE);
  const abortRef = useRef<AbortController | null>(null);
  const contentMode = useContentModeStore((s) => s.contentMode);
  const language = useLanguageStore((s) => s.language);
  const pairKey = context?.pairKey;
  const firstProfileId = context?.profileIds[0];
  const secondProfileId = context?.profileIds[1];
  const edgeRequestKey = context?.edgeRequestKey;
  const identity = useMemo<MeshReadingIdentity | undefined>(
    () =>
      pairKey === undefined ||
      firstProfileId === undefined ||
      secondProfileId === undefined ||
      edgeRequestKey === undefined
        ? undefined
        : {
            pairKey,
            profileIds: [firstProfileId, secondProfileId],
            edgeRequestKey,
            language,
          },
    [pairKey, firstProfileId, secondProfileId, edgeRequestKey, language],
  );
  const saved = useMeshReadingsStore((store) =>
    identity === undefined ? undefined : store.getExact(identity),
  );
  const identityKey =
    identity === undefined
      ? undefined
      : `${identity.pairKey}\u0000${identity.edgeRequestKey}\u0000${identity.language}`;
  const prevIdentityKeyRef = useRef<string | undefined>(identityKey);
  const lastLocalSaveAtRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // A new exact edge/language identity aborts in-flight requests and resets state.
  // Same-identity store updates hydrate durable readings while idle without wiping
  // `failed` sections from our own just-completed partial generation.
  useEffect(() => {
    if (prevIdentityKeyRef.current !== identityKey) {
      prevIdentityKeyRef.current = identityKey;
      lastLocalSaveAtRef.current = null;
      abortRef.current?.abort();
      abortRef.current = null;
      setState(
        saved === undefined
          ? IDLE_STATE
          : { status: 'complete', reading: saved.reading, completed: new Set(), failed: new Set() },
      );
      return;
    }
    if (saved !== undefined && saved.generatedAt === lastLocalSaveAtRef.current) {
      return;
    }
    setState((prev) => {
      if (prev.status === 'streaming') return prev;
      if (saved === undefined) return prev.status === 'error' ? prev : IDLE_STATE;
      return { status: 'complete', reading: saved.reading, completed: new Set(), failed: new Set() };
    });
  }, [identityKey, saved]);

  const generate = useCallback(() => {
    if (!edge || !identity) {
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState((previous) => ({
      status: 'streaming',
      completed: new Set(),
      failed: new Set(),
      ...(previous.reading !== undefined ? { reading: previous.reading } : {}),
    }));

    // The UI edge mirrors the engine's serialized MeshEdgeContext shape; the
    // llm package types the same wire shape locally (structural by design).
    const llmEdge: LlmMeshEdgeContext = edge;
    const run = async (): Promise<void> => {
      await whenDataLifecycleReady();
      if (controller.signal.aborted) return;
      const config = resolveProviderConfig(readMeshLlmEnv());
      const generationMode = contentMode === 'technical' ? 'expert' : 'layman';
      const failedKeys = new Set<MeshReadingSectionKey>();
      const events = streamMeshReading({
        edge: llmEdge,
        config,
        relationship: edge.relationship,
        mode: generationMode,
        language: identity.language,
        signal: controller.signal,
      });
      for await (const event of events) {
        if (controller.signal.aborted) {
          return;
        }
        if (event.type === 'section_complete') {
          setState((prev) => ({
            ...prev,
            completed: new Set([...prev.completed, event.section]),
          }));
        } else if (event.type === 'error' && event.section !== undefined) {
          failedKeys.add(event.section);
          setState((prev) => ({
            ...prev,
            failed: new Set([...prev.failed, event.section!]),
          }));
        } else if (event.type === 'complete') {
          let mergedReading = event.reading;
          const prior = useMeshReadingsStore.getState().getExact(identity)?.reading;
          if (prior && failedKeys.size > 0) {
            mergedReading = {
              connection: failedKeys.has('connection') ? prior.connection : event.reading.connection,
              timing_together: failedKeys.has('timing_together')
                ? prior.timing_together
                : event.reading.timing_together,
              care: failedKeys.has('care') ? prior.care : event.reading.care,
            };
          }
          const generatedAt = new Date().toISOString();
          lastLocalSaveAtRef.current = generatedAt;
          await useMeshReadingsStore.getState().saveCompleted({
            ...identity,
            generationMode,
            provider: configProvenance(config),
            generatedAt,
            reading: mergedReading,
          });
          setState((prev) => ({ ...prev, status: 'complete', reading: mergedReading }));
        }
      }
    };
    run().catch((err: unknown) => {
      if (controller.signal.aborted) {
        return;
      }
      setState((prev) => ({
        ...prev,
        status: 'error',
        error: meshReadingErrorText(err),
      }));
    });
  }, [edge, identity, contentMode]);

  return { ...state, generate };
}
