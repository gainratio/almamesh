/**
 * CanvasLabel — zero-worker, CSP-safe 3D text label for the Living Astrolabe.
 *
 * Why this exists instead of `@react-three/drei`'s `<Text>` (troika-three-text):
 * 1. `troika-worker-utils` spawns a `blob:` Web Worker and calls
 *    `importScripts(blobUrl)` inside it. Under the strict production CSP
 *    (`script-src 'self' 'wasm-unsafe-eval'`), `importScripts(blob:)` is
 *    blocked, throwing an uncaught pageerror (`"Worker module function was
 *    called but init did not return a callable function"`).
 * 2. `troika-worker-utils`'s `blob:` worker also collides with the E2E worker
 *    accounting in `storage-blocked` (which attributes `blob:` workers to the
 *    SQLite OPFS proxy).
 * 3. Drawing onto an offscreen 2D `<canvas>` and uploading a `THREE.CanvasTexture`
 *    uses the already-loaded CSS font (`Hanken Grotesk`) synchronously in <0.1ms
 *    with zero network fetches, zero workers, and deterministic disposal on unmount.
 */

import { useEffect, useMemo, type ReactElement } from 'react';
import * as THREE from 'three';
import { colors } from '@almamesh/constants';

export interface CanvasLabelProps {
  readonly text: string;
  readonly subText?: string;
  readonly color?: string;
  readonly subColor?: string;
  readonly outlineColor?: string;
  readonly opacity?: number;
  readonly worldHeight?: number;
  readonly position?: readonly [number, number, number];
  readonly rotation?: readonly [number, number, number];
}

const FONT_FAMILY = '"Hanken Grotesk", system-ui, -apple-system, sans-serif';
const PRIMARY_PX = 44;
const SUB_PX = 28;
const PAD_X = 20;
const PAD_Y = 14;
const LINE_GAP = 8;

interface BuiltCanvasTexture {
  readonly texture: THREE.CanvasTexture | null;
  readonly aspect: number;
}

function buildLabelTexture(
  text: string,
  subText: string | undefined,
  color: string,
  subColor: string,
  outlineColor: string,
): BuiltCanvasTexture {
  const longestChars = Math.max(text.length, subText ? subText.length * 0.72 : 0);
  const fallbackWidth = Math.max(128, Math.ceil(longestChars * 26 + PAD_X * 2));
  const fallbackHeight = subText
    ? PRIMARY_PX + SUB_PX + LINE_GAP + PAD_Y * 2
    : PRIMARY_PX + PAD_Y * 2;

  if (typeof document === 'undefined') {
    return { texture: null, aspect: fallbackWidth / fallbackHeight };
  }

  const canvas = document.createElement('canvas');
  let ctx: CanvasRenderingContext2D | null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    ctx = null;
  }
  if (!ctx) {
    return { texture: null, aspect: fallbackWidth / fallbackHeight };
  }

  ctx.font = `700 ${PRIMARY_PX}px ${FONT_FAMILY}`;
  const primaryWidth = ctx.measureText(text).width;
  let subWidth = 0;
  if (subText) {
    ctx.font = `600 ${SUB_PX}px ${FONT_FAMILY}`;
    subWidth = ctx.measureText(subText).width;
  }

  const width = Math.max(96, Math.ceil(Math.max(primaryWidth, subWidth) + PAD_X * 2));
  const height = fallbackHeight;
  canvas.width = width;
  canvas.height = height;

  ctx.clearRect(0, 0, width, height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const centerX = width / 2;
  const primaryY = subText ? PAD_Y + PRIMARY_PX * 0.5 : height / 2;

  ctx.font = `700 ${PRIMARY_PX}px ${FONT_FAMILY}`;
  ctx.strokeStyle = outlineColor;
  ctx.lineWidth = 8;
  ctx.strokeText(text, centerX, primaryY);
  ctx.fillStyle = color;
  ctx.fillText(text, centerX, primaryY);

  if (subText) {
    const subY = PAD_Y + PRIMARY_PX + LINE_GAP + SUB_PX * 0.5;
    ctx.font = `600 ${SUB_PX}px ${FONT_FAMILY}`;
    ctx.strokeStyle = outlineColor;
    ctx.lineWidth = 6;
    ctx.strokeText(subText, centerX, subY);
    ctx.fillStyle = subColor;
    ctx.fillText(subText, centerX, subY);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  return { texture, aspect: width / height };
}

export function CanvasLabel({
  text,
  subText,
  color = colors.text.primary,
  subColor = colors.text.secondary,
  outlineColor = colors.background.darkest,
  opacity = 1,
  worldHeight = 0.28,
  position,
  rotation,
}: CanvasLabelProps): ReactElement {
  const { texture, aspect } = useMemo(
    () => buildLabelTexture(text, subText, color, subColor, outlineColor),
    [text, subText, color, subColor, outlineColor],
  );

  useEffect(() => {
    return () => {
      texture?.dispose();
    };
  }, [texture]);

  const worldWidth = worldHeight * aspect;

  return (
    <mesh position={position} rotation={rotation}>
      <planeGeometry args={[worldWidth, worldHeight]} />
      <meshBasicMaterial
        map={texture ?? undefined}
        transparent
        opacity={opacity}
        depthWrite={false}
        depthTest={false}
        side={THREE.DoubleSide}
        toneMapped={false}
      />
    </mesh>
  );
}
