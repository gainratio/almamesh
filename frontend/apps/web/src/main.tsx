import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
// Initialize i18next for its side effect (i18n.init) BEFORE rendering, then
// reuse the same instance in the provider below. Offline, bundled catalogs.
import i18n from './i18n/config'
import { ErrorBoundary } from './components/ErrorBoundary'
import { AlmaMeshRuntimeProvider } from './providers/AlmaMeshRuntimeProvider'
import { runProfileMigration, useLanguageStore } from '@almamesh/store'
import { safeWarn } from '@almamesh/shared-types'
import { installChunkErrorRecovery } from './lib/swSelfHeal'
import { initializePortableState } from './lib/portablePreferences'
import { startupOutcome } from './lib/storageStartup'
import { BlockedStartup } from './components/BlockedStartup'
import App from './App'
// Self-hosted observatory typography (no external font CDN — keeps the app
// fully offline and free of cross-origin requests). Variable fonts: one woff2
// per family, bundled + hashed by Vite and precached by the service worker.
import '@fontsource-variable/fraunces'
import '@fontsource-variable/hanken-grotesk'
import '@fontsource-variable/spline-sans-mono'
import './index.css'

// P5 local-first: there is no backend API to configure and no auth tokens to
// store. The app runs on the in-browser engine + on-device storage; there are
// runtime egresses are explicit and user-facing; README's network/data-flow
// table is the canonical inventory.

let queryClient: QueryClient
queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error: unknown) => {
      // Spec 036: global cache invalidation on 404 to prevent stale UI after backend data loss.
      const maybeStatusCode =
        typeof error === 'object' && error !== null && 'status_code' in error
          ? (error as { status_code?: number }).status_code
          : undefined

      if (maybeStatusCode === 404) {
        safeWarn('cache.query_not_found', error)
        queryClient.invalidateQueries()
      }
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 60 * 1000, // 1 minute
      gcTime: 10 * 60 * 1000, // 10 minutes
      retry: 1,
    },
  },
})

// Auto-recover from a failed code-split import (a stale/poisoned SW cache after a
// deploy). Installed before render so a chunk error anywhere — including dynamic
// imports inside a page — reloads once to the fresh build instead of stranding
// the user. Route chunks additionally retry via lazyWithRetry; the boot-time
// wedge (empty precache) is healed in useServiceWorker.
installChunkErrorRecovery()

/** Hydrate SQLite, migrate profiles, apply the language. Never throws. */
async function prepareState(hydration: Promise<void>): Promise<void> {
  try {
    await hydration

    // Named-profiles migration (no data loss) reads the now-hydrated chart,
    // profile, and chat stores. Complete it before any route guard renders.
    await runProfileMigration()

    const language = useLanguageStore.getState().language
    await i18n.changeLanguage(language)
    document.documentElement.lang = language
  } catch (error) {
    // The persistence-status UI handles unavailable SQLite. Render the app so
    // it can explain the degraded state instead of leaving a blank document.
    safeWarn('storage.state_open_failed', error)
  }
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <React.StrictMode>
      <ErrorBoundary>
        <I18nextProvider i18n={i18n}>
          <QueryClientProvider client={queryClient}>
            <AlmaMeshRuntimeProvider>{children}</AlmaMeshRuntimeProvider>
          </QueryClientProvider>
        </I18nextProvider>
      </ErrorBoundary>
    </React.StrictMode>
  )
}

async function bootstrap(): Promise<void> {
  const root = ReactDOM.createRoot(document.getElementById('root')!)
  const hydration = initializePortableState()
  // SQLite on OPFS is the only store. While the browser refuses it, hydration
  // waits for "Check again"; render the block screen now instead of a blank
  // page, and render the app once the user has allowed storage (no reload).
  if ((await startupOutcome(hydration)) === 'blocked') {
    root.render(
      <Shell>
        <BlockedStartup />
      </Shell>,
    )
  }
  await prepareState(hydration)
  root.render(
    <Shell>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </Shell>,
  )
}

void bootstrap()
