/**
 * ForceFieldScene - composes "The Living Astrolabe": one radiant lagna-tinted
 * core (`NativeCore`), an engraved wheel (`AstrolabeWheel`: concentric orbit
 * tracks, house spokes, Ascendant beacon, and 12 zodiac sign inscriptions),
 * nine token-coloured graha discs at their REAL ecliptic longitudes, and at
 * most three `DashaThread`s (maha lord, antar lord, strongest discord).
 *
 * Labels are on by default (`labelMode = 'all'`), staggered vertically so
 * conjunct planets never overlap, and switchable between `'all'`, `'lords'`,
 * and `'hover'`. Camera supports both 3D Observatory perspective (`'3d'`) and
 * Top-Down Ecliptic Wheel (`'top'`).
 */

import {
  useEffect,
  useMemo,
  useRef,
  type ComponentRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { OrbitControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { colors } from '@almamesh/constants';
import type { EnergyFrame, RGBColor } from '@almamesh/shared-types';
import { PlanetMesh } from './PlanetMesh';
import { NativeCore } from './NativeCore';
import { DashaThread } from './DashaThread';
import {
  GroundPlane,
  HouseRing,
  OrbitTracks,
  ZodiacBand,
} from './AstrolabeWheel';
import { CENTER_Y } from './placement';
import {
  computeLabelElevations,
  entrancePhase,
  planetReveal,
  planetRole,
  planetSubLabel,
  revealOrder,
  selectThreads,
  shouldShowPlanetLabel,
  type CameraViewMode,
  type LabelMode,
} from './astrolabe';

type OrbitControlsImpl = ComponentRef<typeof OrbitControls>;

export interface ForceFieldSceneProps {
  frame: EnergyFrame;
  animationTime: number;
  reducedMotion?: boolean;
  selectedPlanet?: string | null;
  onPlanetSelect?: (id: string | null) => void;
  lagnaColor?: RGBColor;
  houseSpokes?: readonly number[];
  lagnaLongitude?: number;
  labelMode?: LabelMode;
  viewMode?: CameraViewMode;
  autoOrbit?: boolean;
  resetTrigger?: number;
  effects?: ReactNode;
}

const C = {
  base: new THREE.Color(colors.background.primary),
  deep: new THREE.Color(colors.background.darkest),
  nebula: new THREE.Color(colors.accent.lapis),
  brass: new THREE.Color(colors.accent.gold),
  brassBright: new THREE.Color(colors.accent['gold-bright']),
  lapisLight: new THREE.Color(colors.accent.blue),
  star: new THREE.Color(colors.text.secondary),
};

const CAM_3D = new THREE.Vector3(0, 6.2, 13.8);
const CAM_TOP = new THREE.Vector3(0, 17.5, 0.08);
const TARGET_3D = new THREE.Vector3(0, 0.35, 0);
const TARGET_TOP = new THREE.Vector3(0, 0, 0);

function Backdrop() {
  const geometry = useMemo(() => {
    const geo = new THREE.SphereGeometry(60, 32, 24);
    const pos = geo.getAttribute('position');
    const count = pos.count;
    const colorAttr = new Float32Array(count * 3);
    const top = C.nebula.clone().lerp(C.base, 0.72);
    const bottom = C.deep;
    for (let i = 0; i < count; i++) {
      const h = THREE.MathUtils.clamp((pos.getY(i) / 60) * 0.5 + 0.5, 0, 1);
      const t = Math.pow(h, 1.8);
      const c = bottom.clone().lerp(top, t);
      colorAttr[i * 3] = c.r;
      colorAttr[i * 3 + 1] = c.g;
      colorAttr[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colorAttr, 3));
    return geo;
  }, []);

  return (
    <mesh geometry={geometry} scale={[1, 1, 1]}>
      <meshBasicMaterial
        vertexColors
        side={THREE.BackSide}
        depthWrite={false}
        fog={false}
      />
    </mesh>
  );
}

function Starfield({ reducedMotion }: { reducedMotion: boolean }) {
  const groupRef = useRef<THREE.Group>(null);
  const { geometry, material } = useMemo(() => {
    const COUNT = 320;
    const positions = new Float32Array(COUNT * 3);
    const sizes = new Float32Array(COUNT);
    let seed = 0x9e3779b9;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    for (let i = 0; i < COUNT; i++) {
      const r = 30 + rnd() * 18;
      const theta = rnd() * Math.PI * 2;
      const phi = Math.acos(1 - rnd() * 1.4);
      positions[i * 3] = Math.sin(phi) * Math.cos(theta) * r;
      positions[i * 3 + 1] = Math.cos(phi) * r * 0.9 + 4;
      positions[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * r;
      sizes[i] = 0.06 + rnd() * 0.16;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    const mat = new THREE.PointsMaterial({
      color: C.star,
      transparent: true,
      opacity: 0.55,
      sizeAttenuation: true,
      size: 0.14,
      depthWrite: false,
      fog: false,
      blending: THREE.AdditiveBlending,
    });
    return { geometry: geo, material: mat };
  }, []);

  useFrame((_, delta) => {
    if (reducedMotion || !groupRef.current) return;
    groupRef.current.rotation.y += delta * 0.006;
  });

  return (
    <group ref={groupRef}>
      <points geometry={geometry} material={material} />
    </group>
  );
}

const userDragging = { value: false };

function CameraController({
  controlsRef,
  viewMode,
  autoOrbit,
  reducedMotion,
  selectedPlanet,
  resetTrigger,
}: {
  controlsRef: RefObject<OrbitControlsImpl | null>;
  viewMode: CameraViewMode;
  autoOrbit: boolean;
  reducedMotion: boolean;
  selectedPlanet: string | null;
  resetTrigger: number;
}) {
  const { camera } = useThree();
  const transitionFrames = useRef(0);

  useEffect(() => {
    transitionFrames.current = 45;
  }, [viewMode, resetTrigger]);

  useFrame((_, delta) => {
    const controls = controlsRef.current;
    if (!controls) return;

    if (transitionFrames.current > 0 && !userDragging.value) {
      const destPos = viewMode === 'top' ? CAM_TOP : CAM_3D;
      const destTarget = viewMode === 'top' ? TARGET_TOP : TARGET_3D;
      camera.position.lerp(destPos, 0.14);
      if ('target' in controls && controls.target instanceof THREE.Vector3) {
        controls.target.lerp(destTarget, 0.16);
      }
      controls.update?.();
      transitionFrames.current -= 1;
      return;
    }

    if (
      reducedMotion ||
      !autoOrbit ||
      viewMode === 'top' ||
      selectedPlanet !== null ||
      userDragging.value ||
      typeof controls.getAzimuthalAngle !== 'function' ||
      typeof controls.setAzimuthalAngle !== 'function'
    ) {
      return;
    }
    controls.setAzimuthalAngle(controls.getAzimuthalAngle() + delta * 0.038);
    controls.update?.();
  });

  return null;
}

export function ForceFieldScene({
  frame,
  animationTime,
  reducedMotion = false,
  selectedPlanet = null,
  onPlanetSelect,
  lagnaColor,
  houseSpokes,
  lagnaLongitude,
  labelMode = 'all',
  viewMode = '3d',
  autoOrbit = true,
  resetTrigger = 0,
  effects,
}: ForceFieldSceneProps) {
  const controlsRef = useRef<OrbitControlsImpl>(null);

  const handlePlanetSelect = (id: string) => {
    onPlanetSelect?.(selectedPlanet === id ? null : id);
  };

  const sortedPlanets = useMemo(
    () => [...frame.planets].sort((a, b) => a.orbitRadius - b.orbitRadius),
    [frame.planets],
  );

  const orbitRadii = useMemo(
    () => sortedPlanets.map((p) => p.orbitRadius),
    [sortedPlanets],
  );

  const threads = useMemo(
    () => selectThreads(frame.planets, frame.active),
    [frame.planets, frame.active],
  );

  const threadPlanetIds = useMemo(
    () => new Set(threads.map((t) => t.planetId)),
    [threads],
  );

  const labelElevations = useMemo(
    () => computeLabelElevations(frame.planets),
    [frame.planets],
  );

  const revealIndex = useMemo(() => {
    const order = revealOrder(frame.planets);
    return new Map(order.map((id, i) => [id, i]));
  }, [frame.planets]);

  const entrance = entrancePhase(animationTime, reducedMotion);

  return (
    <>
      <Backdrop />
      <Starfield reducedMotion={reducedMotion} />

      <ambientLight intensity={0.52} color={C.base} />
      <hemisphereLight
        intensity={0.38}
        color={C.lapisLight}
        groundColor={C.deep}
      />
      <directionalLight
        position={[6, 11, 6]}
        intensity={1.05}
        color={C.brassBright}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-bias={-0.0005}
      />
      <pointLight position={[-6, 5, -5]} intensity={0.45} color={C.nebula} />
      <spotLight
        position={[0, 9, 0]}
        angle={0.5}
        penumbra={0.6}
        intensity={0.5}
        color={C.brass}
        target-position={[0, 0, 0]}
      />

      <OrbitControls
        ref={controlsRef}
        enablePan={false}
        enableZoom
        enableRotate
        minDistance={6}
        maxDistance={24}
        maxPolarAngle={Math.PI * 0.82}
        minPolarAngle={0.02}
        target={[0, 0.35, 0]}
        enableDamping
        dampingFactor={0.06}
        rotateSpeed={0.55}
        onStart={() => {
          userDragging.value = true;
        }}
        onEnd={() => {
          userDragging.value = false;
        }}
      />

      <CameraController
        controlsRef={controlsRef}
        viewMode={viewMode}
        autoOrbit={autoOrbit}
        reducedMotion={reducedMotion}
        selectedPlanet={selectedPlanet}
        resetTrigger={resetTrigger}
      />

      <GroundPlane />
      <OrbitTracks radii={orbitRadii} sweep={entrance.ring} />
      <ZodiacBand sweep={entrance.ring} showSignLabels={labelMode !== 'hover'} />

      {houseSpokes && houseSpokes.length > 0 && (
        <HouseRing
          spokes={houseSpokes}
          lagnaLongitude={lagnaLongitude}
          sweep={entrance.ring}
          showLabels={labelMode !== 'hover'}
        />
      )}

      {threads.map((spec) => {
        const planet = sortedPlanets.find((p) => p.id === spec.planetId);
        if (!planet) return null;
        return (
          <DashaThread
            key={`thread-${spec.planetId}`}
            planet={planet}
            kind={spec.kind}
            time={animationTime}
            reducedMotion={reducedMotion}
            drawProgress={entrance.threads}
          />
        );
      })}

      <group position={[0, CENTER_Y, 0]}>
        <NativeCore
          aura={frame.aura}
          time={animationTime}
          reducedMotion={reducedMotion}
          lagnaColor={lagnaColor}
          ignition={entrance.core}
          showLabel={labelMode === 'all'}
        />
      </group>

      {sortedPlanets.map((planet) => {
        const role = planetRole(planet.id, frame.active);
        const isKeyRole = role.isLord || threadPlanetIds.has(planet.id);
        const isSelected = selectedPlanet === planet.id;
        return (
          <PlanetMesh
            key={planet.id}
            planet={planet}
            time={animationTime}
            role={role}
            reveal={planetReveal(
              animationTime,
              revealIndex.get(planet.id) ?? 0,
              sortedPlanets.length,
              reducedMotion,
            )}
            onSelect={handlePlanetSelect}
            isSelected={isSelected}
            isDimmed={selectedPlanet !== null && !isSelected}
            showLabel={shouldShowPlanetLabel(
              labelMode,
              isKeyRole,
              false,
              isSelected,
            )}
            subLabel={planetSubLabel(planet, frame.active, threads)}
            labelElevation={labelElevations.get(planet.id) ?? 0.56}
            reducedMotion={reducedMotion}
          />
        );
      })}

      <fog attach="fog" args={[colors.background.darkest, 14, 36]} />

      {effects}
    </>
  );
}
