/**
 * Is this WebGL context drawn by the CPU instead of a GPU?
 *
 * With no usable GPU (a blocklisted driver, a VM, headless Linux Chromium)
 * browsers fall back to a software rasterizer: SwiftShader in Chromium,
 * llvmpipe/softpipe in Mesa, Microsoft Basic Render Driver on Windows. There
 * an animated scene with bloom costs most of a second per frame on the main
 * thread, which starves everything else on the page, including leaving it
 * (measured: ~8 s to get from the dashboard to the next page).
 */

/** The slice of a WebGL context this check reads. */
export interface RendererInfoSource {
  readonly RENDERER: number;
  getExtension(name: string): unknown;
  getParameter(parameter: number): unknown;
}

const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|basic render driver|software/i;

/** The renderer's name: the unmasked one when the browser exposes it. */
function rendererName(gl: RendererInfoSource): string {
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info') as {
    readonly UNMASKED_RENDERER_WEBGL: number;
  } | null;
  const name = gl.getParameter(debugInfo?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER);
  return typeof name === 'string' ? name : '';
}

/** True when the context renders in software; an unreadable name counts as a GPU. */
export function isSoftwareRenderer(gl: RendererInfoSource): boolean {
  return SOFTWARE_RENDERER.test(rendererName(gl));
}
