import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { Texture } from 'three';

import { sharedTexturesOf } from './releaseSharedTextures';

/**
 * Mounted inside the force-field Canvas. While frames render it notes which
 * renderer-shared textures (three's DFG LUT) the scene uses; on unmount it stops
 * the frame loop and disposes them, which detaches this renderer from the
 * module-level texture so the renderer, its WebGL context and the scene can be
 * collected (see ./releaseSharedTextures).
 */
export function SharedTextureRelease(): null {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const setFrameloop = useThree((state) => state.setFrameloop);
  const shared = useRef(new Set<Texture>());

  useFrame(() => {
    if (shared.current.size > 0) return;
    for (const texture of sharedTexturesOf(gl.properties, scene)) shared.current.add(texture);
  });

  useEffect(() => {
    const textures = shared.current;
    return () => {
      // R3F disposes the renderer ~500 ms later; drawing meanwhile would re-upload.
      setFrameloop('never');
      for (const texture of textures) texture.dispose();
    };
  }, [setFrameloop]);

  return null;
}
