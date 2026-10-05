/**
 * WebGlGate: the 3D force field is decoration. A browser that cannot create a
 * WebGL context (no GPU, a blocklisted driver, headless Linux Firefox) used to
 * throw inside three.js and take the whole dashboard, chart included, down to
 * the "Something went wrong" card.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { supportsWebGl, WebGlGate } from '../WebGlGate';

function Boom(): never {
  throw new Error('THREE.WebGLRenderer: A WebGL context could not be created.');
}

function canvasFactory(context: unknown): () => HTMLCanvasElement {
  return () => ({ getContext: () => context }) as unknown as HTMLCanvasElement;
}

afterEach(() => vi.restoreAllMocks());

describe('supportsWebGl', () => {
  it('is false when the browser returns no WebGL context', () => {
    expect(supportsWebGl(canvasFactory(null))).toBe(false);
  });

  it('is true when a context exists, and releases it', () => {
    const loseContext = vi.fn();
    const context = { getExtension: () => ({ loseContext }) };
    expect(supportsWebGl(canvasFactory(context))).toBe(true);
    expect(loseContext).toHaveBeenCalledOnce();
  });

  it('is false when asking for a context throws', () => {
    const throwing = () =>
      ({
        getContext: () => {
          throw new Error('blocked');
        },
      }) as unknown as HTMLCanvasElement;
    expect(supportsWebGl(throwing)).toBe(false);
  });
});

describe('WebGlGate', () => {
  it('shows the fallback instead of the scene when WebGL is unavailable', () => {
    render(
      <WebGlGate available={false} fallback={<p>no 3D here</p>}>
        <p>scene</p>
      </WebGlGate>,
    );
    expect(screen.getByText('no 3D here')).toBeTruthy();
    expect(screen.queryByText('scene')).toBeNull();
  });

  it('keeps the page when the scene throws, showing the fallback in its place', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <div>
        <p>the chart</p>
        <WebGlGate available fallback={<p>no 3D here</p>}>
          <Boom />
        </WebGlGate>
      </div>,
    );
    expect(screen.getByText('the chart')).toBeTruthy();
    expect(screen.getByText('no 3D here')).toBeTruthy();
  });

  it('renders the scene when WebGL works', () => {
    render(
      <WebGlGate available fallback={<p>no 3D here</p>}>
        <p>scene</p>
      </WebGlGate>,
    );
    expect(screen.getByText('scene')).toBeTruthy();
  });
});
