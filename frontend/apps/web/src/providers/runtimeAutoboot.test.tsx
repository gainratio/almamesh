import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

import type { BootStage, ChartEngine, OnStage, RuntimeConfig } from '@almamesh/browser'
import { AlmaMeshRuntimeProvider } from './AlmaMeshRuntimeProvider'
import { useChartEngine } from './chartEngineContext'

// hasLocalChart is the synchronous "does a saved chart exist?" probe the gate
// consults. Mock it so we can drive the landing-vs-app decision deterministically.
vi.mock('../lib/localChart', () => ({
  hasLocalChart: vi.fn(() => false),
}))
import { hasLocalChart } from '../lib/localChart'

/**
 * Minimal `AlmaMeshRuntime` stand-in (mirrors the existing provider test): each
 * `bootstrap()` resolves a ready engine and bumps a call counter so the test can
 * assert whether the mount auto-boot fired.
 */
interface FakeRuntime {
  bootstrap(config: RuntimeConfig, onStage?: OnStage): Promise<ChartEngine>
  bootstrapCalls: number
}

function makeFakeEngine(): ChartEngine {
  return {
    generateChart: vi.fn(),
    computePredictive: vi.fn(),
    computeMeshEdge: vi.fn(),
    meta: () => ({
      bundle_id: 'test',
      version: '0',
      engine_version: '0',
      ephemeris_file: 'de421.bsp',
      ayanamsa: 'lahiri',
      constructs: [],
    }),
  } as unknown as ChartEngine
}

function makeFakeRuntime(): FakeRuntime {
  return {
    bootstrapCalls: 0,
    bootstrap(_config: RuntimeConfig, onStage: OnStage = () => {}) {
      this.bootstrapCalls += 1
      onStage({ kind: 'ready' } as BootStage)
      return Promise.resolve(makeFakeEngine())
    },
  }
}

interface ProbeProps {
  readonly revision?: string
}

/** Surfaces whether the context exposes startBootstrap, for the contract assertion. */
function Probe({ revision = 'initial' }: ProbeProps) {
  const value = useChartEngine()
  return (
    <span data-testid="startBootstrap" data-revision={revision}>
      {typeof value.startBootstrap === 'function' ? 'has-startBootstrap' : 'no-startBootstrap'}
    </span>
  )
}

/** Set the initial location the provider reads at mount (it sits above the router). */
function setPath(pathname: string) {
  window.history.pushState({}, '', pathname)
}

function runtimeProviderUi(runtime: FakeRuntime, revision: string) {
  return (
    <AlmaMeshRuntimeProvider runtime={runtime}>
      <Probe revision={revision} />
    </AlmaMeshRuntimeProvider>
  )
}

function renderRuntimeProvider(runtime = makeFakeRuntime()) {
  return { runtime, view: render(runtimeProviderUi(runtime, 'initial')) }
}

describe('AlmaMeshRuntimeProvider — auto-boot gating', () => {
  beforeEach(() => {
    vi.mocked(hasLocalChart).mockReturnValue(false)
    setPath('/')
  })

  afterEach(() => {
    vi.clearAllMocks()
    setPath('/')
  })

  it('does NOT auto-boot on the landing route (path "/" with no saved chart)', async () => {
    vi.mocked(hasLocalChart).mockReturnValue(false)
    setPath('/')
    const runtime = makeFakeRuntime()

    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe />
      </AlmaMeshRuntimeProvider>,
    )

    // Give any (incorrect) async mount effect a chance to fire.
    await Promise.resolve()
    await Promise.resolve()
    expect(runtime.bootstrapCalls).toBe(0)
  })

  it('DOES auto-boot on an engine route (e.g. "/onboarding")', async () => {
    vi.mocked(hasLocalChart).mockReturnValue(false)
    setPath('/onboarding')
    const runtime = makeFakeRuntime()

    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe />
      </AlmaMeshRuntimeProvider>,
    )

    await waitFor(() => expect(runtime.bootstrapCalls).toBe(1))
  })

  it('boots once when runtime and mount-gate boundaries change after mount', async () => {
    setPath('/onboarding')
    const { runtime, view } = renderRuntimeProvider()

    await waitFor(() => expect(runtime.bootstrapCalls).toBe(1))
    const replacementRuntime = makeFakeRuntime()
    vi.mocked(hasLocalChart).mockReturnValue(true)
    setPath('/')
    view.rerender(runtimeProviderUi(replacementRuntime, 'after-boundary-change'))

    expect(screen.getByTestId('startBootstrap').getAttribute('data-revision')).toBe(
      'after-boundary-change',
    )
    expect(runtime.bootstrapCalls + replacementRuntime.bootstrapCalls).toBe(1)
  })

  it('DOES auto-boot on "/" when a chart already exists (returning visitor)', async () => {
    vi.mocked(hasLocalChart).mockReturnValue(true)
    setPath('/')
    const runtime = makeFakeRuntime()

    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe />
      </AlmaMeshRuntimeProvider>,
    )

    await waitFor(() => expect(runtime.bootstrapCalls).toBe(1))
  })

  // `/welcome` is the shareable splash: it ALWAYS renders the pitch, even for a
  // visitor with a saved chart, and is documented engine-free like `/`. Booting
  // it on mount downloaded the whole engine for a page that never uses it, and
  // those downloads kept the previous service worker busy, so an accepted
  // update sat in `waiting` until they finished (CI run 37146730486).
  it.each([
    ['/welcome', false],
    ['/welcome', true],
    ['/welcome/', true],
  ])('does NOT auto-boot on the splash %s (saved chart: %s)', async (path, hasChart) => {
    vi.mocked(hasLocalChart).mockReturnValue(hasChart)
    setPath(path)
    const { runtime } = renderRuntimeProvider()

    await Promise.resolve()
    await Promise.resolve()
    expect(runtime.bootstrapCalls).toBe(0)
  })

  it('exposes an idempotent startBootstrap() on the context', () => {
    setPath('/')
    const runtime = makeFakeRuntime()

    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe />
      </AlmaMeshRuntimeProvider>,
    )

    expect(screen.getByTestId('startBootstrap').textContent).toBe('has-startBootstrap')
  })
})
