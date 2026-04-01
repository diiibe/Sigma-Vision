import { animated, useSpring } from "@react-spring/three";
import type { SlotStatus } from "../data/types";
import {
  DEFAULT_SCENE_COLOR_TUNING,
  deriveSlotVisualState,
  tuneHexColor,
  type SceneColorTuning,
  type SlotOverlayMetric,
  type SlotOverlayState,
} from "./slotOverlay";

interface ParkingSlotProps {
  id: string;
  position: [number, number];
  size: [number, number];
  status: SlotStatus;
  highlighted: boolean;
  hovered: boolean;
  selected: boolean;
  levelOpacity: number;
  overlays: SlotOverlayState;
  overlayMetric?: SlotOverlayMetric;
  colorTuning?: SceneColorTuning;
  reducedMotion: boolean;
  onHover(slotId: string | null): void;
  onSelect(slotId: string): void;
}

export function ParkingSlot({
  id,
  position,
  size,
  status,
  highlighted,
  hovered,
  selected,
  levelOpacity,
  overlays,
  overlayMetric,
  colorTuning = DEFAULT_SCENE_COLOR_TUNING,
  reducedMotion,
  onHover,
  onSelect,
}: ParkingSlotProps) {
  const baseOpacity = highlighted ? levelOpacity : levelOpacity * 0.16;
  const visualState = deriveSlotVisualState(status, overlays, overlayMetric, colorTuning);
  const bayOutlineColor = tuneHexColor(visualState.outlineColor, {
    saturation: colorTuning.bayOutlineSaturation,
    lightness: colorTuning.bayOutlineLightness,
  });
  const tuningDelta =
    Math.abs(colorTuning.saturation - 1) * 0.8 +
    Math.abs(colorTuning.lightness - 1) * 1.05;
  const bayOutlineDelta =
    Math.abs(colorTuning.bayOutlineSaturation - 1) * 0.8 +
    Math.abs(colorTuning.bayOutlineLightness - 1) * 1.05;
  const fillOpacity = Math.min(
    1,
    baseOpacity * (1 + tuningDelta * (highlighted ? 0.5 : 0.3)),
  );
  const outlineOpacityBase = selected || hovered ? 1 : highlighted ? 0.44 : 0.2;
  const outlineOpacity = Math.min(1, outlineOpacityBase + bayOutlineDelta * 0.22);
  const emissiveBoost = 1 + tuningDelta * 0.9;
  const springs = useSpring({
    scale: selected ? 1.08 : hovered ? 1.04 : 1,
    opacity: fillOpacity,
    outlineOpacity,
    config: reducedMotion
      ? { duration: 0 }
      : { mass: 1.1, tension: 210, friction: 24 },
  });

  return (
    <animated.group
      position={[position[0], 0.08, position[1]]}
      scale={springs.scale.to((value) => [value, 1, value])}
    >
      <mesh
        onPointerOver={(event) => {
          event.stopPropagation();
          onHover(id);
        }}
        onPointerOut={(event) => {
          event.stopPropagation();
          onHover(null);
        }}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(id);
        }}
      >
        <boxGeometry args={[size[0], 0.1, size[1]]} />
        <animated.meshStandardMaterial
          color={visualState.fillColor}
          roughness={0.36}
          metalness={0.18}
          transparent
          opacity={springs.opacity}
          emissive={visualState.emissiveColor}
          emissiveIntensity={
            selected
              ? Math.max(0.34, visualState.emissiveIntensity * emissiveBoost)
              : hovered
                ? Math.max(0.18, visualState.emissiveIntensity * emissiveBoost * 0.86)
                : visualState.emissiveIntensity * emissiveBoost
          }
        />
      </mesh>

      <mesh scale={[1.06, 1.08, 1.06]}>
        <boxGeometry args={[size[0], 0.08, size[1]]} />
        <animated.meshBasicMaterial
          wireframe
          color={selected ? "#dde5ef" : bayOutlineColor}
          transparent
          opacity={springs.outlineOpacity}
        />
      </mesh>
    </animated.group>
  );
}
