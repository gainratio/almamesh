/**
 * NativeCore - the single hero of the Living Astrolabe.
 *
 * The centre is a lagna-tinted radiant nucleus framed by two counter-rotating
 * armillary gimbal rings (replacing the muddy double icosahedron shells) plus
 * ONE expanding flux ring. Its colour carries the aura's net flux (brass =
 * constructive, lapis = destructive, ivory = balanced — `colors.forcefield`
 * tokens) and its rate comes from `ringRateFromNetFlux` (≤ 0.5 rad/s, decoupled
 * from planet count) so the core breathes instead of strobing.
 *
 * `ignition` (0..1) drives the entrance: the core scales/brightens in first.
 */

import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';
import { colors } from '@almamesh/constants';
import type { AuraState, RGBColor } from '@almamesh/shared-types';
import { ringRateFromNetFlux } from './astrolabe';

const FLUX_CONSTRUCTIVE = new THREE.Color(colors.forcefield.fluxConstructive);
const FLUX_DESTRUCTIVE = new THREE.Color(colors.forcefield.fluxDestructive);
const FLUX_BALANCED = new THREE.Color(colors.forcefield.fluxBalanced);
const BRASS = new THREE.Color(colors.accent.gold);
const FONT_URL = '/fonts/HankenGrotesk-Bold.ttf';

interface NativeCoreProps {
  aura: AuraState;
  time: number;
  reducedMotion?: boolean;
  /** Lagna (ascendant) tint, RGB 0-1, identifies "the native". */
  lagnaColor?: RGBColor;
  /** Entrance ignition 0..1 (1 = fully lit). */
  ignition?: number;
  /** Whether to show the subtle SELF / CORE label above the nucleus. */
  showLabel?: boolean;
}

/**
 * Net-flux colour from the observatory tokens — a CONTINUOUS lapis→brass lerp
 * (netFlux oscillates each frame; discrete state bands would pop). A touch of
 * ivory softens the balanced middle.
 */
function fluxColor(netFlux: number): THREE.Color {
  const t = (Math.max(-1, Math.min(1, netFlux)) + 1) / 2;
  const c = FLUX_DESTRUCTIVE.clone().lerp(FLUX_CONSTRUCTIVE, t);
  return c.lerp(FLUX_BALANCED, 0.16 * (1 - Math.abs(Math.max(-1, Math.min(1, netFlux)))));
}

/**
 * The ONE ring system: a single ring expanding outward and fading, colour +
 * rate carrying the net flux. Calm by construction (rate capped at 0.5 rad/s).
 */
function FluxRing({
  color,
  netFlux,
  intensity,
  time,
  reducedMotion,
}: {
  color: THREE.Color;
  netFlux: number;
  intensity: number;
  time: number;
  reducedMotion: boolean;
}) {
  const ringRef = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  const rate = ringRateFromNetFlux(netFlux);

  useFrame((state) => {
    if (!ringRef.current || !matRef.current) return;
    const animTime = reducedMotion ? time : state.clock.elapsedTime;
    const cycle = reducedMotion
      ? 0.35
      : ((animTime * rate) % (Math.PI * 2)) / (Math.PI * 2);
    ringRef.current.scale.setScalar(0.95 + cycle * 1.15);
    matRef.current.opacity = (1 - cycle) * intensity;
  });

  return (
    <mesh ref={ringRef} position={[0, -0.1, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[1.38, 1.44, 64]} />
      <meshBasicMaterial
        ref={matRef}
        color={color}
        transparent
        opacity={intensity}
        side={THREE.DoubleSide}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </mesh>
  );
}

export function NativeCore({
  aura,
  time,
  reducedMotion = false,
  lagnaColor,
  ignition = 1,
  showLabel = false,
}: NativeCoreProps) {
  const outerGimbalRef = useRef<THREE.Mesh>(null);
  const innerGimbalRef = useRef<THREE.Mesh>(null);
  const haloRef = useRef<THREE.Mesh>(null);
  const labelRef = useRef<THREE.Group>(null);

  const coreColor = useMemo(() => {
    if (!lagnaColor) return FLUX_CONSTRUCTIVE.clone();
    return new THREE.Color(lagnaColor[0], lagnaColor[1], lagnaColor[2]);
  }, [lagnaColor]);

  const shellColor = useMemo(() => fluxColor(aura.netFlux), [aura.netFlux]);

  useFrame((state) => {
    const animTime = reducedMotion ? time : state.clock.elapsedTime;
    const pulseSpeed = 0.4 + (1 - aura.stability) * 0.5;
    const pulseAmount = 0.04 + (1 - aura.stability) * 0.04;
    const pulse = 1 + Math.sin(animTime * pulseSpeed) * pulseAmount;
    const baseScale = (0.55 + 0.45 * ignition) * pulse;

    if (haloRef.current) {
      haloRef.current.scale.setScalar(baseScale * (0.9 + aura.glow * 0.22));
    }
    if (outerGimbalRef.current && innerGimbalRef.current) {
      outerGimbalRef.current.scale.setScalar(baseScale);
      innerGimbalRef.current.scale.setScalar(baseScale);
      if (!reducedMotion) {
        outerGimbalRef.current.rotation.y += 0.0025;
        innerGimbalRef.current.rotation.y -= 0.0035;
      }
    }
    if (labelRef.current) {
      labelRef.current.quaternion.copy(state.camera.quaternion);
    }
  });

  const emissiveIntensity = (0.45 + Math.abs(aura.netFlux) * 0.45) * ignition;
  const ringIntensity = (0.42 + Math.abs(aura.netFlux) * 0.25) * ignition;

  return (
    <group>
      {/* Radiant lagna-tinted nucleus — crisp lit sphere. */}
      <mesh scale={0.4 + 0.6 * ignition}>
        <sphereGeometry args={[0.42, 32, 32]} />
        <meshStandardMaterial
          color={coreColor}
          emissive={coreColor}
          emissiveIntensity={emissiveIntensity * 2.6}
          roughness={0.25}
          metalness={0.15}
        />
      </mesh>

      {/* Soft additive corona (replaces the murky grey double icosahedron). */}
      <mesh ref={haloRef}>
        <sphereGeometry args={[0.64, 24, 24]} />
        <meshBasicMaterial
          color={shellColor}
          transparent
          opacity={(0.14 + aura.glow * 0.12) * ignition}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>

      {/* Precision armillary gimbal rings tilted at the 23.5° ecliptic obliquity. */}
      <mesh ref={outerGimbalRef} rotation={[0.41, 0, 0]}>
        <torusGeometry args={[0.92, 0.014, 16, 64]} />
        <meshBasicMaterial
          color={BRASS}
          transparent
          opacity={0.42 * ignition}
          depthWrite={false}
        />
      </mesh>

      <mesh ref={innerGimbalRef} rotation={[-0.41, Math.PI / 3, 0]}>
        <torusGeometry args={[0.76, 0.012, 16, 64]} />
        <meshBasicMaterial
          color={shellColor}
          transparent
          opacity={0.36 * ignition}
          depthWrite={false}
        />
      </mesh>

      <FluxRing
        color={shellColor}
        netFlux={aura.netFlux}
        intensity={ringIntensity}
        time={time}
        reducedMotion={reducedMotion}
      />

      {showLabel && ignition > 0.7 && (
        <group ref={labelRef} position={[0, -0.78, 0]}>
          <Text
            font={FONT_URL}
            fontSize={0.16}
            color={colors.text.secondary}
            fillOpacity={0.78}
            anchorX="center"
            anchorY="top"
            outlineWidth={0.024}
            outlineColor={colors.background.darkest}
          >
            SELF · LAGNA
          </Text>
        </group>
      )}

      <pointLight
        color={shellColor}
        intensity={aura.glow * 2 * ignition}
        distance={5}
        decay={2}
      />
    </group>
  );
}
