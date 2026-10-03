/**
 * The generating screen's "what the engine is doing" line. It subscribes to the
 * byte-level progress context on its own, so the page that hosts it (and the
 * form fields on it) never re-render for a progress report.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) =>
      [key, ...Object.values(params ?? {})].join(' '),
  }),
}));

import type { BootStage } from '@almamesh/browser';
import { EngineBootProgressContext } from '../../providers/chartEngineContext';
import { EngineBootProgress } from '../EngineBootProgress';

function renderWith(stage: BootStage | null) {
  return render(
    <EngineBootProgressContext.Provider value={stage}>
      <EngineBootProgress />
    </EngineBootProgressContext.Provider>,
  );
}

describe('EngineBootProgress', () => {
  it('renders nothing before the bootstrap reports anything', () => {
    renderWith(null);
    expect(screen.queryByTestId('engine-progress')).toBeNull();
  });

  it('renders nothing outside the provider (prerender, tests)', () => {
    render(<EngineBootProgress />);
    expect(screen.queryByTestId('engine-progress')).toBeNull();
  });

  it('shows the bundle download with a bar sized by the signed byte total', () => {
    renderWith({
      kind: 'syncing',
      progress: { phase: 'chunks', bytesDone: 250_000, bytesTotal: 1_000_000 } as never,
    });
    const block = screen.getByTestId('engine-progress');
    expect(block.textContent).toBe('generating.engine_download 0.3 1.0');
    expect(screen.getByTestId('engine-progress-bar').style.width).toBe('25%');
  });

  it('shows the Pyodide runtime download without a bar (no byte total)', () => {
    renderWith({ kind: 'booting-engine', progress: { stage: 'runtime', bytesReceived: 2_000_000 } as never });
    expect(screen.getByTestId('engine-progress').textContent).toBe('generating.engine_runtime 2.0');
    expect(screen.queryByTestId('engine-progress-bar')).toBeNull();
  });

  it('renders nothing once the engine is ready', () => {
    renderWith({ kind: 'ready' });
    expect(screen.queryByTestId('engine-progress')).toBeNull();
  });
});
