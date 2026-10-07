/**
 * Release the textures three.js shares across every WebGLRenderer.
 *
 * three.js (r186, still the latest) creates ONE module-level DFG LUT texture
 * (`getDFGLUT()`, uniform `dfgLUT`) for all lit materials. Every renderer that
 * uploads it adds a 'dispose' listener to it, and `renderer.dispose()` does not
 * remove that listener. The module-level texture therefore retains every
 * renderer ever created, and through it the WebGL context, the canvas and the
 * whole scene. Each dashboard visit leaked one; WebKit then logs "too many
 * active WebGL contexts" and keeps the memory.
 *
 * Disposing the shared texture fires those listeners: each renderer frees its
 * GPU copy and detaches itself. A renderer still in use simply re-uploads it on
 * its next frame (the texture keeps its data and version).
 *
 * The scene is emptied as R3F unmounts, so `SharedTextureRelease` collects the
 * textures while frames render and disposes them on unmount.
 */
import type { Material, Mesh, Object3D, Texture } from 'three';

/** The slice of `WebGLRenderer.properties` this needs. */
export interface RendererProperties {
  get(object: object): unknown;
}

interface MaterialProperties {
  readonly uniforms?: Readonly<Record<string, { readonly value: unknown } | undefined>>;
}

const SHARED_TEXTURE_UNIFORMS = ['dfgLUT'] as const;

function materialsOf(scene: Object3D): Set<Material> {
  const materials = new Set<Material>();
  scene.traverse((object) => {
    const material = (object as Partial<Mesh>).material;
    if (material === undefined) return;
    for (const entry of Array.isArray(material) ? material : [material]) materials.add(entry);
  });
  return materials;
}

function isTexture(value: unknown): value is Texture {
  return typeof value === 'object' && value !== null && (value as Partial<Texture>).isTexture === true;
}

/** The renderer-shared textures the scene's materials use (see above). */
export function sharedTexturesOf(properties: RendererProperties, scene: Object3D): Set<Texture> {
  const shared = new Set<Texture>();
  for (const material of materialsOf(scene)) {
    const uniforms = (properties.get(material) as MaterialProperties | undefined)?.uniforms;
    for (const name of SHARED_TEXTURE_UNIFORMS) {
      const value = uniforms?.[name]?.value;
      if (isTexture(value)) shared.add(value);
    }
  }
  return shared;
}

export function releaseSharedTextures(properties: RendererProperties, scene: Object3D): void {
  for (const texture of sharedTexturesOf(properties, scene)) texture.dispose();
}
