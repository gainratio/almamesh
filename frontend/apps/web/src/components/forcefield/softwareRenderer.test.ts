import { describe, expect, it } from 'vitest';
import { isSoftwareRenderer } from './softwareRenderer';

const UNMASKED_RENDERER_WEBGL = 0x9246;
const RENDERER = 0x1f01;

/** A WebGL context stub: `debugName` is what WEBGL_debug_renderer_info reports, `plainName` RENDERER. */
function context(plainName: string, debugName?: string) {
  return {
    RENDERER,
    getExtension: (name: string) =>
      name === 'WEBGL_debug_renderer_info' && debugName !== undefined ? { UNMASKED_RENDERER_WEBGL } : null,
    getParameter: (parameter: number) => (parameter === UNMASKED_RENDERER_WEBGL ? debugName : plainName),
  };
}

describe('isSoftwareRenderer', () => {
  it.each([
    'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
    'Google SwiftShader',
    'llvmpipe (LLVM 15.0.7, 256 bits)',
    'softpipe',
    'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0)',
  ])('flags %s as software', (name) => {
    expect(isSoftwareRenderer(context('WebKit WebGL', name))).toBe(true);
  });

  it.each([
    'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
    'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)',
    'Mali-G78',
    'Apple GPU',
  ])('keeps %s on the GPU path', (name) => {
    expect(isSoftwareRenderer(context('WebKit WebGL', name))).toBe(false);
  });

  it('reads RENDERER when the debug extension is unavailable', () => {
    expect(isSoftwareRenderer(context('Google SwiftShader'))).toBe(true);
    expect(isSoftwareRenderer(context('Apple GPU'))).toBe(false);
  });

  it('treats an unreadable renderer as a GPU', () => {
    expect(isSoftwareRenderer({ RENDERER, getExtension: () => null, getParameter: () => null })).toBe(false);
  });
});
