/**
 * AstrolabeWheel — the engraved ecliptic wheel, concentric planetary tracks,
 * 12 zodiac sector inscriptions, house cusp spokes, and Ascendant (Lagna)
 * pointer.
 *
 * Uses `/fonts/HankenGrotesk-Bold.ttf` with ASCII-only strings so troika never
 * triggers an off-origin unicode font fallback.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';
import { colors } from '@almamesh/constants';
import { ZODIAC_ABBR, signAbbrFromLongitude } from './astrolabe';

export const ZODIAC_RADIUS = 8;
const OUTER_RIM_RADIUS = 8.55;
const FONT_URL = '/fonts/HankenGrotesk-Bold.ttf';

const C = {
  brass: new THREE.Color(colors.accent.gold),
  brassBright: new THREE.Color(colors.accent['gold-bright']),
  spoke: new THREE.Color(colors.accent.lapis).multiplyScalar(0.65),
  track: new THREE.Color(colors.accent.gold).multiplyScalar(0.38),
  obsidian: new THREE.Color(colors.background.darkest),
};

export function GroundPlane() {
  return (
    <group position={[0, -0.18, 0]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[10.5, 64]} />
        <meshStandardMaterial
          color={colors.background.darker}
          transparent
          opacity={0.72}
          roughness={0.95}
          metalness={0.05}
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <ringGeometry args={[1.52, 1.56, 64]} />
        <meshBasicMaterial
          color={C.brass}
          transparent
          opacity={0.28}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

/** Faint concentric orbital tracks so every planet sits on a legible shell. */
export function OrbitTracks({
  radii,
  sweep,
}: {
  readonly radii: readonly number[];
  readonly sweep: number;
}) {
  const uniqueRadii = useMemo(
    () => Array.from(new Set(radii.map((r) => Math.round(r * 100) / 100))),
    [radii],
  );
  const clamped = Math.max(0, Math.min(1, sweep));

  return (
    <group position={[0, -0.03, 0]}>
      {uniqueRadii.map((r) => (
        <mesh key={`track-${r}`} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[r - 0.014, r + 0.014, 96]} />
          <meshBasicMaterial
            color={C.track}
            transparent
            opacity={0.22 * clamped}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  );
}

/** Outer brass zodiac ring with 12 sign ticks, 36 decan ticks, and 12 sign labels. */
export function ZodiacBand({
  sweep,
  showSignLabels = true,
}: {
  readonly sweep: number;
  readonly showSignLabels?: boolean;
}) {
  const innerRing = useMemo(
    () => new THREE.RingGeometry(ZODIAC_RADIUS - 0.045, ZODIAC_RADIUS + 0.045, 180, 1),
    [],
  );
  const outerRing = useMemo(
    () => new THREE.RingGeometry(OUTER_RIM_RADIUS - 0.03, OUTER_RIM_RADIUS + 0.03, 180, 1),
    [],
  );
  const tickGeometry = useMemo(() => {
    const verts: number[] = [];
    for (let i = 0; i < 36; i++) {
      const a = (-i * 10 * Math.PI) / 180;
      const isMajor = i % 3 === 0;
      const r0 = isMajor ? ZODIAC_RADIUS - 0.35 : ZODIAC_RADIUS + 0.04;
      const r1 = isMajor ? OUTER_RIM_RADIUS + 0.02 : ZODIAC_RADIUS + 0.18;
      verts.push(
        Math.cos(a) * r0, 0, Math.sin(a) * r0,
        Math.cos(a) * r1, 0, Math.sin(a) * r1,
      );
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    return geo;
  }, []);
  const tickMaterial = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: C.brass,
        transparent: true,
        opacity: 0.35,
      }),
    [],
  );
  const ticks = useMemo(
    () => new THREE.LineSegments(tickGeometry, tickMaterial),
    [tickGeometry, tickMaterial],
  );

  useEffect(() => {
    const clamped = Math.max(0, Math.min(1, sweep));
    const idxInner = innerRing.index ? innerRing.index.count : 0;
    const idxOuter = outerRing.index ? outerRing.index.count : 0;
    innerRing.setDrawRange(0, Math.floor((idxInner * clamped) / 3) * 3);
    outerRing.setDrawRange(0, Math.floor((idxOuter * clamped) / 3) * 3);
    tickMaterial.opacity = 0.35 * clamped;
  }, [innerRing, outerRing, tickMaterial, sweep]);

  useEffect(() => {
    return () => {
      innerRing.dispose();
      outerRing.dispose();
      tickGeometry.dispose();
      tickMaterial.dispose();
    };
  }, [innerRing, outerRing, tickGeometry, tickMaterial]);

  const labelRadius = (ZODIAC_RADIUS + OUTER_RIM_RADIUS) * 0.5;

  return (
    <group position={[0, -0.02, 0]}>
      <mesh geometry={innerRing} rotation={[-Math.PI / 2, 0, 0]}>
        <meshBasicMaterial
          color={C.brass}
          transparent
          opacity={0.34}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <mesh geometry={outerRing} rotation={[-Math.PI / 2, 0, 0]}>
        <meshBasicMaterial
          color={C.brass}
          transparent
          opacity={0.22}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <primitive object={ticks} />
      {showSignLabels &&
        sweep > 0.65 &&
        ZODIAC_ABBR.map((abbr, idx) => {
          const midLon = idx * 30 + 15;
          const a = (-midLon * Math.PI) / 180;
          const x = Math.cos(a) * labelRadius;
          const z = Math.sin(a) * labelRadius;
          return (
            <Text
              key={abbr}
              position={[x, 0.02, z]}
              rotation={[-Math.PI / 2, 0, a - Math.PI / 2]}
              font={FONT_URL}
              fontSize={0.21}
              color={colors.text.secondary}
              fillOpacity={0.72 * Math.min(1, (sweep - 0.65) / 0.35)}
              anchorX="center"
              anchorY="middle"
              outlineWidth={0.018}
              outlineColor={colors.background.darkest}
            >
              {abbr}
            </Text>
          );
        })}
    </group>
  );
}

/** Radial house cusp spokes + billboarded Ascendant (Lagna) beacon. */
export function HouseRing({
  spokes,
  lagnaLongitude,
  sweep,
  showLabels = true,
}: {
  readonly spokes: readonly number[];
  readonly lagnaLongitude?: number;
  readonly sweep: number;
  readonly showLabels?: boolean;
}) {
  const ascLabelRef = useRef<THREE.Group>(null);
  const { lines, materials } = useMemo(() => {
    const inner = 1.56;
    const outer = ZODIAC_RADIUS - 0.08;
    const mats: THREE.LineBasicMaterial[] = [];
    const objs = spokes.map((lon, idx) => {
      const a = (-lon * Math.PI) / 180;
      const isAngular = idx % 3 === 0;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(
          [
            Math.cos(a) * inner,
            0,
            Math.sin(a) * inner,
            Math.cos(a) * outer,
            0,
            Math.sin(a) * outer,
          ],
          3,
        ),
      );
      const mat = new THREE.LineBasicMaterial({
        color: isAngular ? C.brass : C.spoke,
        transparent: true,
        opacity: isAngular ? 0.38 : 0.25,
      });
      mats.push(mat);
      return new THREE.Line(geo, mat);
    });
    return { lines: objs, materials: mats };
  }, [spokes]);

  useEffect(() => {
    const clamped = Math.max(0, Math.min(1, sweep));
    materials.forEach((mat, idx) => {
      mat.opacity = (idx % 3 === 0 ? 0.38 : 0.25) * clamped;
    });
  }, [materials, sweep]);

  useEffect(() => {
    return () => {
      for (const line of lines) {
        line.geometry.dispose();
        (line.material as THREE.Material).dispose();
      }
    };
  }, [lines]);

  useFrame((state) => {
    if (ascLabelRef.current) {
      ascLabelRef.current.quaternion.copy(state.camera.quaternion);
    }
  });

  const ascAngle =
    typeof lagnaLongitude === 'number' ? (-lagnaLongitude * Math.PI) / 180 : null;
  const ascSign =
    typeof lagnaLongitude === 'number' ? signAbbrFromLongitude(lagnaLongitude) : '';

  return (
    <group position={[0, -0.02, 0]}>
      {lines.map((line, i) => (
        <primitive key={`spoke-${i}`} object={line} />
      ))}
      {ascAngle !== null && (
        <group
          position={[
            Math.cos(ascAngle) * (OUTER_RIM_RADIUS + 0.38),
            0.03,
            Math.sin(ascAngle) * (OUTER_RIM_RADIUS + 0.38),
          ]}
        >
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.14, 0.22, 24]} />
            <meshBasicMaterial
              color={C.brassBright}
              transparent
              opacity={0.9 * sweep}
              side={THREE.DoubleSide}
            />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[0.09, 20]} />
            <meshBasicMaterial color={C.brassBright} transparent opacity={0.95 * sweep} />
          </mesh>
          {showLabels && sweep > 0.6 && (
            <group ref={ascLabelRef} position={[0, 0.38, 0]}>
              <Text
                font={FONT_URL}
                fontSize={0.2}
                color={colors.accent['gold-bright']}
                anchorX="center"
                anchorY="bottom"
                outlineWidth={0.03}
                outlineColor={colors.background.darkest}
              >
                {`ASC · ${ascSign}`}
              </Text>
            </group>
          )}
        </group>
      )}
    </group>
  );
}
