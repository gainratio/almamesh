/**
 * Register the ONE chart-regeneration runner behind `requestRegeneration`.
 *
 * Onboarding, Rectify and Settings call `requestRegeneration(event)` and AWAIT
 * it; this is the single place the chart is (re)computed — replacing the
 * duplicated inline sequences that caused the orphan / dropped-`profile_id` /
 * stale-interpretation bugs. Awaiting matters: pages used to emit on a
 * fire-and-forget bus and navigate at once, so a reload during the compute
 * lost the first chart for good (prod 6a89c0e, 2026-10-05).
 *
 * RACE-PROOF against request-before-ready: the in-browser engine bootstraps
 * asynchronously, and the onboarding warming-race / post-`reboot()` recovery
 * paths request a regeneration the instant the engine resolves — which can
 * land BEFORE this hook sees the ready engine on its next render. The runner is
 * ALWAYS registered (it reads the engine from a ref), so a request is computed
 * the moment the engine is ready and BUFFERED otherwise; a ready-transition
 * effect then DRAINS the buffer exactly once, and the buffered request's
 * promise settles with that run. No dropped compute, regardless of ordering.
 */

import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  newChartReferenceInstant,
  regenerateOnBirthChange,
  registerRegenerationRunner,
  useChartLibraryStore,
  useChatStore,
  useInterpretationStore,
  usePredictiveStore,
  type BirthInfoChanged,
} from '@almamesh/store'

import { useChartEngine } from '../providers/AlmaMeshRuntimeProvider'
import { clearAllChartData } from '../stores/chart'
import type { ChartEngine } from '@almamesh/browser'

export function useRegenerationSubscription(): void {
  const { engine } = useChartEngine()
  const queryClient = useQueryClient()

  // The engine, read live by the always-attached listener so it never captures
  // a stale `null` from the render when it was first attached.
  const engineRef = useRef<ChartEngine | null>(engine)
  engineRef.current = engine

  // A single birth-info event awaiting a ready engine (the emit-before-ready
  // case). Only the latest matters — a newer commit supersedes an older one,
  // and every caller waiting on a superseded event settles with the winner.
  const pendingRef = useRef<PendingRegeneration | null>(null)

  // The regeneration runner, held in a ref so the always-attached listener has a
  // stable identity. Reassigned every render so its closed-over `queryClient`
  // stays current. Reads the engine from the ref: compute now if ready, else
  // buffer for the ready-transition effect to drain.
  const runRef = useRef<(event: BirthInfoChanged) => Promise<void>>(() => Promise.resolve())
  runRef.current = (event: BirthInfoChanged) => {
    const currentEngine = engineRef.current
    if (currentEngine === null) {
      return bufferUntilReady(pendingRef, event)
    }
    return regenerateOnBirthChange(event, {
      engine: currentEngine,
      library: useChartLibraryStore.getState(),
      chat: useChatStore.getState(),
      interpretations: useInterpretationStore.getState(),
      // The app's "as of now" — read here, at the edge, and recorded on the
      // chart. Everything below this line is a pure function of it.
      referenceInstant: newChartReferenceInstant(),
      onRegenerated: () => {
        // The predictive superset is natal-input-dependent. A rectification,
        // birth-time edit, or location edit must never leave the previous
        // chart's transits/vargas/strength/domains associated with the new one.
        // A delayed profile-A regeneration must not erase profile B's current
        // cache after the user switches people while the engine is working.
        const predictive = usePredictiveStore.getState()
        if (event.profileId === null || predictive.profileKey === event.profileId) {
          predictive.reset()
        }
        clearAllChartData()
        void queryClient.invalidateQueries({ queryKey: ['primary-chart'] })
      },
    })
  }

  // Register as THE runner ONCE for the app's lifetime (never gated on
  // `engine`), so `requestRegeneration` always reaches this hook.
  useEffect(() => registerRegenerationRunner((event) => runRef.current(event)), [])

  // When the engine becomes ready, DRAIN a buffered event exactly once. This is
  // what recovers the warming-race / post-reboot dashboard: the event that fired
  // before the engine was ready is now computed.
  useEffect(() => {
    if (engine === null) {
      return
    }
    const pending = pendingRef.current
    if (pending !== null) {
      pendingRef.current = null
      runRef.current(pending.event).then(pending.resolve, pending.reject)
    }
  }, [engine])
}

/** The latest event awaiting a ready engine, plus how to settle its waiters. */
interface PendingRegeneration {
  readonly event: BirthInfoChanged
  readonly resolve: () => void
  readonly reject: (reason: unknown) => void
}

/**
 * Hold `event` until the engine is ready. A newer event replaces an older one
 * (last wins); the older caller's promise settles with the newer run's outcome.
 */
function bufferUntilReady(
  pendingRef: { current: PendingRegeneration | null },
  event: BirthInfoChanged,
): Promise<void> {
  const superseded = pendingRef.current
  return new Promise<void>((resolve, reject) => {
    pendingRef.current = {
      event,
      resolve: () => {
        superseded?.resolve()
        resolve()
      },
      reject: (reason: unknown) => {
        superseded?.reject(reason)
        reject(reason)
      },
    }
  })
}
