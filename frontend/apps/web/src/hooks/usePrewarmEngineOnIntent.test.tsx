import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'

import type { BootStage, ChartEngine, OnStage, RuntimeConfig } from '@almamesh/browser'
import { AlmaMeshRuntimeProvider } from '../providers/AlmaMeshRuntimeProvider'
import { usePrewarmEngineOnIntent } from './usePrewarmEngineOnIntent'

// The engine boots only once canonical SQLite is durable on OPFS; these tests
// are about other behavior, so storage is ready from the start.
vi.mock('@almamesh/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@almamesh/store')>()),
  portableStatePersistence: () => 'opfs',
  subscribePortableStatePersistence: () => () => undefined,
}))

// Keep the provider on the landing path so its mount does NOT auto-boot; this
// isolates the boot calls to the ones the prewarm hook makes.
vi.mock('../lib/localChart', () => ({
  hasLocalChart: vi.fn(() => false),
}))

interface FakeRuntime {
  bootstrap(config: RuntimeConfig, onStage?: OnStage): Promise<ChartEngine>
  bootstrapCalls: number
}

function makeFakeRuntime(): FakeRuntime {
  return {
    bootstrapCalls: 0,
    bootstrap(_config: RuntimeConfig, onStage: OnStage = () => {}) {
      this.bootstrapCalls += 1
      onStage({ kind: 'ready' } as BootStage)
      return Promise.resolve({
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
      } as unknown as ChartEngine)
    },
  }
}

/** Renders the prewarm handlers as buttons so the test can fire each intent. */
function PrewarmHarness() {
  const { onPointerEnter, onFocus, onClick } = usePrewarmEngineOnIntent()
  return (
    <div>
      <button type="button" data-testid="enter" onPointerEnter={onPointerEnter}>
        enter
      </button>
      <button type="button" data-testid="focus" onFocus={onFocus}>
        focus
      </button>
      <button type="button" data-testid="click" onClick={onClick}>
        click
      </button>
    </div>
  )
}

describe('usePrewarmEngineOnIntent', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/')
  })

  afterEach(() => {
    vi.clearAllMocks()
    window.history.pushState({}, '', '/')
  })

  it('returns the three intent handlers', () => {
    const runtime = makeFakeRuntime()
    let handlers: ReturnType<typeof usePrewarmEngineOnIntent> | null = null

    function Capture() {
      handlers = usePrewarmEngineOnIntent()
      return null
    }

    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Capture />
      </AlmaMeshRuntimeProvider>,
    )

    expect(typeof handlers!.onPointerEnter).toBe('function')
    expect(typeof handlers!.onFocus).toBe('function')
    expect(typeof handlers!.onClick).toBe('function')
  })

  it('starts the bootstrap exactly once even across multiple intents', () => {
    const runtime = makeFakeRuntime()

    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <PrewarmHarness />
      </AlmaMeshRuntimeProvider>,
    )

    // No auto-boot on the landing path.
    expect(runtime.bootstrapCalls).toBe(0)

    // Fire every intent, several times each.
    const click = screen.getByTestId('click')
    click.click()
    click.click()
    screen.getByTestId('focus').focus()
    screen.getByTestId('enter').dispatchEvent(new Event('pointerenter', { bubbles: true }))

    expect(runtime.bootstrapCalls).toBe(1)
  })

  it('a single handler invoked repeatedly still boots only once', () => {
    const runtime = makeFakeRuntime()

    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <PrewarmHarness />
      </AlmaMeshRuntimeProvider>,
    )

    const click = screen.getByTestId('click')
    click.click()
    click.click()
    click.click()

    expect(runtime.bootstrapCalls).toBe(1)
  })
})
