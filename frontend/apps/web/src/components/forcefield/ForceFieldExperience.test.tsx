import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import '../../i18n/config';
import { DEMO_CHART } from '../../lib/demoChart';

/** What the force field asked of the (mocked) R3F Canvas, plus the GPU it "got". */
const canvas = vi.hoisted(() => ({
  frameloop: [] as string[],
  renderer: 'ANGLE (Apple, Apple M2, OpenGL 4.1)',
}));

function fakeRenderer(name: string) {
  const context = {
    RENDERER: 0x1f01,
    getExtension: () => null,
    getParameter: () => name,
  };
  return { getContext: () => context };
}

vi.mock('@react-three/fiber', () => ({
  Canvas: ({
    frameloop,
    onCreated,
  }: {
    frameloop: string;
    onCreated?: (state: { gl: ReturnType<typeof fakeRenderer> }) => void;
    children?: ReactNode;
  }) => {
    canvas.frameloop.push(frameloop);
    useEffect(() => onCreated?.({ gl: fakeRenderer(canvas.renderer) }), [onCreated]);
    return <div data-testid="canvas" />;
  },
}));
vi.mock('@react-three/postprocessing', () => ({
  EffectComposer: () => null,
  Bloom: () => null,
  Vignette: () => null,
}));
vi.mock('./ForceFieldScene', () => ({ ForceFieldScene: () => null }));

import { ForceFieldExperience } from './ForceFieldExperience';

afterEach(() => {
  canvas.frameloop.length = 0;
  canvas.renderer = 'ANGLE (Apple, Apple M2, OpenGL 4.1)';
  vi.restoreAllMocks();
});

describe('ForceFieldExperience on a software WebGL renderer', () => {
  it('keeps animating on a GPU', () => {
    render(<ForceFieldExperience chart={DEMO_CHART} />);
    expect(canvas.frameloop.at(-1)).toBe('always');
  });

  it('holds a still scene when WebGL runs in software (SwiftShader), so it cannot starve navigation', async () => {
    canvas.renderer =
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';
    render(<ForceFieldExperience chart={DEMO_CHART} />);
    expect(canvas.frameloop.at(-1)).toBe('demand');

    // The animation clock stops too: no further frames are requested.
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(raf).not.toHaveBeenCalled();
  });
});

describe('ForceFieldExperience interactive HUD & planet inspector', () => {
  it('renders the interactive HUD and 9-planet selector bar by default, and omits them when decorative', () => {
    const { unmount } = render(<ForceFieldExperience chart={DEMO_CHART} />);
    expect(screen.getByTestId('forcefield-hud')).toBeTruthy();
    expect(screen.getByTestId('forcefield-core-status').textContent).toContain('Core:');
    expect(screen.getByTestId('forcefield-planet-bar')).toBeTruthy();
    unmount();

    render(<ForceFieldExperience chart={DEMO_CHART} decorative />);
    expect(screen.queryByTestId('forcefield-hud')).toBeNull();
  });

  it('selects a planet from the pill bar, opens the inspector, and notifies onSelectPlanet', () => {
    const onSelect = vi.fn();
    render(<ForceFieldExperience chart={DEMO_CHART} onSelectPlanet={onSelect} />);

    const jupiterPill = screen.getByTestId('forcefield-pill-jupiter');
    fireEvent.click(jupiterPill);

    expect(onSelect).toHaveBeenCalledWith('jupiter');
    expect(screen.getByTestId('forcefield-inspector').textContent).toContain('jupiter');

    // Clicking Close clears selection.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it('toggles camera perspective and label mode controls', () => {
    render(<ForceFieldExperience chart={DEMO_CHART} />);
    const topWheelBtn = screen.getByRole('button', { name: 'Top Wheel' });
    expect(topWheelBtn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(topWheelBtn);
    expect(topWheelBtn.getAttribute('aria-pressed')).toBe('true');

    const labelsBtn = screen.getByRole('button', { name: 'Labels: All' });
    fireEvent.click(labelsBtn);
    expect(screen.getByRole('button', { name: 'Labels: Lords' })).toBeTruthy();
  });
});
