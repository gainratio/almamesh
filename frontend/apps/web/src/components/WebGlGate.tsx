import { Component, type ErrorInfo, type ReactNode } from 'react';
import { safeWarn } from '@almamesh/shared-types';

/**
 * The 3D force field is decoration over the 2D chart. Some browsers cannot
 * create a WebGL context: no GPU, a blocklisted driver, WebGL turned off, or
 * headless Firefox on Linux, where it fails now and then. three.js then throws
 * during render, and before this gate that error reached the route boundary and
 * replaced the whole dashboard, chart included, with "Something went wrong".
 */

/** Ask for a throwaway WebGL context; release it straight away. */
export function supportsWebGl(
  createCanvas: () => HTMLCanvasElement = () => document.createElement('canvas'),
): boolean {
  try {
    const canvas = createCanvas();
    const context = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (context === null) return false;
    context.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    // A browser that throws here cannot draw the scene either.
    return false;
  }
}

interface WebGlGateProps {
  /** Whether a WebGL context could be created (see supportsWebGl). */
  readonly available: boolean;
  /** Shown instead of the scene when WebGL is missing or the scene throws. */
  readonly fallback: ReactNode;
  readonly children: ReactNode;
}

interface WebGlGateState {
  readonly failed: boolean;
}

export class WebGlGate extends Component<WebGlGateProps, WebGlGateState> {
  public override state: WebGlGateState = { failed: false };

  public static getDerivedStateFromError(): WebGlGateState {
    return { failed: true };
  }

  public override componentDidCatch(error: Error, _info: ErrorInfo): void {
    safeWarn('render.webgl_unavailable', error);
  }

  public override render(): ReactNode {
    const { available, fallback, children } = this.props;
    return available && !this.state.failed ? children : fallback;
  }
}
