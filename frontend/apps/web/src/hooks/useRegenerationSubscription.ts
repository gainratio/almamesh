/**
 * Subscribe the ONE chart-regeneration handler to `birth-info-changed`.
 *
 * Onboarding and Settings EMIT `birth-info-changed`; this is the single place
 * the chart is (re)computed — replacing the duplicated inline sequences that
 * caused the orphan / dropped-`profile_id` / stale-interpretation bugs.
 *
 * RACE-PROOF against emit-before-subscribe: the in-browser engine bootstraps
 * asynchronously, and the onboarding warming-race / post-`reboot()` recovery
 * paths emit `birth-info-changed` the instant the engine resolves — which can
 * land BEFORE this subscriber sees the ready engine on its next render. The old
 * effect early-returned `if (!engine)` and attached the listener only once the
 * engine was non-null, so that early emit fired into the void and the dashboard
 * showed "Unable to Load Chart". Here the listener is ALWAYS attached (it reads
 * the engine from a ref), so a live event is computed the moment the engine is
 * ready and BUFFERED otherwise; a ready-transition effect then DRAINS the buffer
 * exactly once. No dropped compute, regardless of ordering.
 */

import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  appEvents,
  newChartReferenceInstant,
  regenerateOnBirthChange,
  useChartLibraryStore,
  useChatStore,
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
  // case). Only the latest matters — a newer commit supersedes an older one.
  const pendingRef = useRef<BirthInfoChanged | null>(null)

  // The regeneration runner, held in a ref so the always-attached listener has a
  // stable identity. Reassigned every render so its closed-over `queryClient`
  // stays current. Reads the engine from the ref: compute now if ready, else
  // buffer for the ready-transition effect to drain.
  const runRef = useRef<(event: BirthInfoChanged) => void>(() => {})
  runRef.current = (event: BirthInfoChanged) => {
    const currentEngine = engineRef.current
    if (currentEngine === null) {
      pendingRef.current = event
      return
    }
    void regenerateOnBirthChange(event, {
      engine: currentEngine,
      library: useChartLibraryStore.getState(),
      chat: useChatStore.getState(),
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

  // Attach the listener ONCE for the app's lifetime (never gated on `engine`).
  useEffect(() => {
    const handler = (event: BirthInfoChanged) => runRef.current(event)
    appEvents.on('birth-info-changed', handler)
    return () => appEvents.off('birth-info-changed', handler)
  }, [])

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
      runRef.current(pending)
    }
  }, [engine])
}
