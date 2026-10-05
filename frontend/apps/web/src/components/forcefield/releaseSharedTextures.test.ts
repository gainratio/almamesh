import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

import { releaseSharedTextures, type RendererProperties } from './releaseSharedTextures';

/**
 * three.js r186 keeps ONE module-level DFG LUT texture for every lit material.
 * Each WebGLRenderer that uploads it adds a 'dispose' listener to it and never
 * removes it on renderer.dispose(), so the module-level texture retains every
 * renderer ever created, and with it the WebGL context and the scene. Measured:
 * 20 dashboard visits kept 21 contexts alive after a forced GC, and WebKit
 * logged "too many active WebGL contexts". Disposing the shared texture on
 * unmount fires those listeners, which detach each renderer from it.
 */
function rendererWith(uniformsByMaterial: Map<THREE.Material, Record<string, { value: unknown }>>): RendererProperties {
  return { get: (material: object) => ({ uniforms: uniformsByMaterial.get(material as THREE.Material) }) };
}

describe('releaseSharedTextures', () => {
  it('disposes the shared DFG LUT a lit material uses, so renderer listeners on it are released', () => {
    const lut = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    const rendererListener = vi.fn();
    lut.addEventListener('dispose', rendererListener);
    const lit = new THREE.MeshStandardMaterial();
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(), lit));

    releaseSharedTextures(rendererWith(new Map([[lit, { dfgLUT: { value: lut } }]])), scene);

    expect(rendererListener).toHaveBeenCalledTimes(1);
  });

  it('disposes it once even when many materials share it, and ignores materials without one', () => {
    const lut = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    const rendererListener = vi.fn();
    lut.addEventListener('dispose', rendererListener);
    const a = new THREE.MeshStandardMaterial();
    const b = new THREE.MeshPhysicalMaterial();
    const unlit = new THREE.MeshBasicMaterial();
    const scene = new THREE.Scene();
    for (const material of [a, b, unlit]) scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));

    releaseSharedTextures(
      rendererWith(new Map([[a, { dfgLUT: { value: lut } }], [b, { dfgLUT: { value: lut } }]])),
      scene,
    );

    expect(rendererListener).toHaveBeenCalledTimes(1);
  });
});
