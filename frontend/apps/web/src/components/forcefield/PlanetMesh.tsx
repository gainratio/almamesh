/**
 * PlanetMesh - one graha glyph in the Living Astrolabe.
 *
 * Placement is the planet's TRUE ecliptic longitude (shared `planetPosition`),
 * anchored to the wheel by a vertical drop-pin + foot-ring on the ecliptic
 * plane so 3D depth is immediately legible.
 *
 * Labels billboard toward the camera with a two-line readout (Name + Role/Sign
 * degree) and stagger vertically when planets are conjunct so labels never
 * collide. Uses `/fonts/HankenGrotesk-Bold.ttf` with ASCII strings so zero
 * third-party font requests occur.
 */

import { useRef, useState, useMemo, useEffect } from 'react';
import {
  useFrame,
  extend,
  type ThreeEvent,
  type ThreeElement,
} from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';
import { colors } from '@almamesh/constants';
import type { PlanetWave } from '@almamesh/shared-types';
import { planetPosition } from './placement';
import { labelVisible, type PlanetRole } from './astrolabe';

const RING_FRIEND = colors.status.exalted;
const RING_ENEMY = colors.status.debilitated;
const RING_NEUTRAL = colors.text.secondary;
const LABEL_COLOR = colors.text.primary;
const LABEL_OUTLINE = colors.background.darkest;
const RAHU_TINT = new THREE.Color(colors.forcefield.rahuTint);
const KETU_TINT = new THREE.Color(colors.forcefield.ketuTint);
const FONT_URL = '/fonts/HankenGrotesk-Bold.ttf';

type AstrolabeDiscUniforms = {
  baseColor: THREE.IUniform<THREE.Color>;
  glowColor: THREE.IUniform<THREE.Color>;
  glowIntensity: THREE.IUniform<number>;
  opacity: THREE.IUniform<number>;
  isHovered: THREE.IUniform<number>;
  isSelected: THREE.IUniform<number>;
  desaturate: THREE.IUniform<number>;
  swirl: THREE.IUniform<number>;
  time: THREE.IUniform<number>;
};

class AstrolabeDiscMaterial extends THREE.ShaderMaterial {
  declare uniforms: AstrolabeDiscUniforms;

  constructor() {
    super({
      uniforms: {
        baseColor: { value: new THREE.Color(1, 1, 1) },
        glowColor: { value: new THREE.Color(1, 1, 1) },
        glowIntensity: { value: 0.3 },
        opacity: { value: 1.0 },
        isHovered: { value: 0.0 },
        isSelected: { value: 0.0 },
        desaturate: { value: 0.0 },
        swirl: { value: 0.0 },
        time: { value: 0.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 baseColor;
        uniform vec3 glowColor;
        uniform float glowIntensity;
        uniform float opacity;
        uniform float isHovered;
        uniform float isSelected;
        uniform float desaturate;
        uniform float swirl;
        uniform float time;
        varying vec2 vUv;

        void main() {
          vec2 centeredUv = (vUv - 0.5) * 2.0;
          float dist = length(centeredUv);
          if (dist > 1.0) discard;

          float z = sqrt(max(0.0, 1.0 - dist * dist));
          vec3 normal = normalize(vec3(centeredUv, z));
          vec3 lightDir = normalize(vec3(-0.45, 0.65, 0.85));
          float lambert = clamp(dot(normal, lightDir), 0.0, 1.0);
          vec3 halfVec = normalize(lightDir + vec3(0.0, 0.0, 1.0));
          float spec = pow(max(dot(normal, halfVec), 0.0), 28.0) * 0.32;
          float shade = 0.38 + 0.62 * lambert;
          vec3 col = baseColor * shade + vec3(spec);

          float angle = atan(centeredUv.y, centeredUv.x);
          float band = sin(angle * 5.0 + dist * 7.0 - time * 0.6) * 0.5 + 0.5;
          col *= mix(1.0, 0.82 + band * 0.24, swirl);

          float lum = dot(col, vec3(0.299, 0.587, 0.114));
          col = mix(col, vec3(lum), desaturate * 0.8);

          float fresnel = pow(1.0 - z, 2.1);
          col += glowColor * fresnel * (glowIntensity + isHovered * 0.3 + isSelected * 0.45);

          float alpha = (1.0 - smoothstep(0.96, 1.0, dist)) * opacity;
          gl_FragColor = vec4(col, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }
}
extend({ AstrolabeDiscMaterial });

declare module '@react-three/fiber' {
  interface ThreeElements {
    astrolabeDiscMaterial: ThreeElement<typeof AstrolabeDiscMaterial>;
  }
}

interface PlanetMeshProps {
  planet: PlanetWave;
  time: number;
  role: PlanetRole;
  reveal?: number;
  onSelect?: (id: string) => void;
  isSelected?: boolean;
  isDimmed?: boolean;
  showLabel?: boolean;
  subLabel?: string;
  labelElevation?: number;
  reducedMotion?: boolean;
  useRealLongitude?: boolean;
}

function getFriendlinessColor(friendliness: number): string {
  if (friendliness > 0.5) return RING_FRIEND;
  if (friendliness < -0.5) return RING_ENEMY;
  return RING_NEUTRAL;
}

function getSubLabelColor(subLabel: string | undefined, isSelected: boolean): string {
  if (isSelected) return colors.accent['gold-bright'];
  if (!subLabel) return colors.text.secondary;
  if (subLabel.includes('MAHA')) return colors.accent['gold-bright'];
  if (subLabel.includes('ANTAR')) return colors.status['own-sign'];
  if (subLabel.includes('FRICTION')) return colors.status.debilitated;
  return colors.text.secondary;
}

export function PlanetMesh({
  planet,
  time,
  role,
  reveal = 1,
  onSelect,
  isSelected = false,
  isDimmed = false,
  showLabel = false,
  subLabel,
  labelElevation = 0.56,
  reducedMotion = false,
  useRealLongitude = true,
}: PlanetMeshProps) {
  const planetMeshRef = useRef<THREE.Mesh>(null);
  const labelGroupRef = useRef<THREE.Group>(null);
  const haloRef = useRef<THREE.Mesh>(null);
  const footRef = useRef<THREE.Group>(null);
  const materialRef = useRef<AstrolabeDiscMaterial>(null);
  const [hovered, setHovered] = useState(false);

  const isShadowNode = planet.id === 'rahu' || planet.id === 'ketu';

  const planetColor = useMemo(() => {
    if (planet.id === 'rahu') return RAHU_TINT.clone();
    if (planet.id === 'ketu') return KETU_TINT.clone();
    return new THREE.Color(planet.waveColor[0], planet.waveColor[1], planet.waveColor[2]);
  }, [planet.id, planet.waveColor]);

  const pinGeometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, -0.02, 0, 0, labelElevation - 0.08, 0], 3),
    );
    return geo;
  }, [labelElevation]);

  const pinMaterial = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: planetColor,
        transparent: true,
        opacity: 0.35,
      }),
    [planetColor],
  );

  const pinLine = useMemo(
    () => new THREE.Line(pinGeometry, pinMaterial),
    [pinGeometry, pinMaterial],
  );

  useEffect(() => {
    return () => {
      pinGeometry.dispose();
      pinMaterial.dispose();
    };
  }, [pinGeometry, pinMaterial]);

  useEffect(() => {
    const material = materialRef.current;
    if (!material) return;
    material.uniforms.baseColor.value = planetColor;
    material.uniforms.glowColor.value = planetColor;
    material.uniforms.glowIntensity.value = role.isLord ? 0.52 : 0.28;
    material.uniforms.swirl.value = isShadowNode ? 1.0 : 0.0;
  }, [planetColor, role.isLord, isShadowNode]);

  useFrame((state) => {
    const mesh = planetMeshRef.current;
    if (!mesh) return;

    const animTime = reducedMotion ? time : state.clock.elapsedTime;
    const { x, y, z } = planetPosition(planet, animTime, useRealLongitude);

    mesh.position.set(x, y, z);
    mesh.quaternion.copy(state.camera.quaternion);

    if (footRef.current) {
      footRef.current.position.set(x, 0, z);
    }
    if (labelGroupRef.current) {
      labelGroupRef.current.position.set(x, y + labelElevation, z);
      labelGroupRef.current.quaternion.copy(state.camera.quaternion);
    }
    if (haloRef.current) haloRef.current.position.set(x, y - 0.05, z);

    const pulse = 1 + Math.sin(animTime * 1.1) * role.pulseAmplitude;
    const revealScale = 0.4 + 0.6 * reveal;
    const scale = (0.32 + planet.amplitude * 0.4) * role.scale * pulse * revealScale;
    mesh.scale.setScalar(scale);

    const dimFactor = isDimmed ? 0.38 : 1;
    pinMaterial.opacity = (isSelected || hovered ? 0.65 : 0.28) * dimFactor * reveal;

    if (materialRef.current) {
      materialRef.current.uniforms.time.value = animTime;
      materialRef.current.uniforms.isHovered.value = hovered ? 1.0 : 0.0;
      materialRef.current.uniforms.isSelected.value = isSelected ? 1.0 : 0.0;
      materialRef.current.uniforms.desaturate.value = planet.isCombust ? 1.0 : 0.0;
      const baseOpacity = isSelected
        ? 1.0
        : hovered
          ? Math.min(role.opacity + 0.25, 1)
          : role.opacity;
      materialRef.current.uniforms.opacity.value = baseOpacity * dimFactor * reveal;
    }
  });

  const displayName = planet.id.charAt(0).toUpperCase() + planet.id.slice(1);
  const initialX = Math.cos((-planet.eclipticLongitude * Math.PI) / 180) * planet.orbitRadius;
  const initialZ = Math.sin((-planet.eclipticLongitude * Math.PI) / 180) * planet.orbitRadius;
  const revealLabel = showLabel || labelVisible(hovered, isSelected);
  const revealHalo = role.isLord || labelVisible(hovered, isSelected);
  const primaryText = [
    displayName,
    planet.isRetrograde ? '(R)' : '',
    planet.isCombust ? '(C)' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const isEmphasized = role.isLord || isSelected || hovered;
  const labelOpacity = (isDimmed ? 0.45 : isEmphasized ? 1.0 : 0.86) * reveal;

  return (
    <group>
      {/* Ecliptic anchor pin + foot-ring on the wheel plane. */}
      <group ref={footRef} position={[initialX, 0, initialZ]}>
        <primitive object={pinLine} />
        <mesh position={[0, -0.015, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.1, 0.16, 24]} />
          <meshBasicMaterial
            color={planetColor}
            transparent
            opacity={(isEmphasized ? 0.65 : 0.32) * reveal}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      </group>

      <mesh
        ref={planetMeshRef}
        scale={[1, 1, 1]}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          onSelect?.(planet.id);
        }}
        onPointerOver={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          setHovered(true);
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          setHovered(false);
          document.body.style.cursor = 'default';
        }}
      >
        <planeGeometry args={[1, 1]} />
        <astrolabeDiscMaterial ref={materialRef} attach="material" />
      </mesh>

      {revealLabel && reveal > 0.35 && (
        <group ref={labelGroupRef} position={[initialX, labelElevation, initialZ]}>
          <Text
            font={FONT_URL}
            fontSize={isEmphasized ? 0.24 : 0.19}
            color={isSelected ? colors.accent['gold-bright'] : LABEL_COLOR}
            fillOpacity={labelOpacity}
            anchorX="center"
            anchorY="bottom"
            outlineWidth={0.032}
            outlineColor={LABEL_OUTLINE}
            fontWeight="bold"
          >
            {primaryText}
          </Text>
          {subLabel && (
            <Text
              position={[0, -0.03, 0]}
              font={FONT_URL}
              fontSize={isEmphasized ? 0.145 : 0.125}
              color={getSubLabelColor(subLabel, isSelected)}
              fillOpacity={labelOpacity * 0.92}
              anchorX="center"
              anchorY="top"
              outlineWidth={0.024}
              outlineColor={LABEL_OUTLINE}
            >
              {subLabel}
            </Text>
          )}
        </group>
      )}

      {revealHalo && (
        <mesh
          ref={haloRef}
          position={[initialX, -0.05, initialZ]}
          rotation={[-Math.PI / 2, 0, 0]}
        >
          <ringGeometry args={[0.42, 0.5, 32]} />
          <meshBasicMaterial
            color={getFriendlinessColor(planet.friendlinessToActive)}
            transparent
            opacity={hovered || isSelected ? 0.85 : 0.45}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      )}
    </group>
  );
}
