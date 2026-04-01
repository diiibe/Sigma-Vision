import { animated, useSpring, useTransition } from "@react-spring/three";
import { Line } from "@react-three/drei";
import type { ParkingLevel as ParkingLevelType, SlotStatus } from "../data/types";
import { isSceneSlotHighlighted } from "./sceneSelection";
import { ParkingSlot } from "./ParkingSlot";
import {
  DEFAULT_SCENE_COLOR_TUNING,
  tuneHexColor,
  type SceneColorTuning,
  type SlotOverlayMetricsById,
  type SlotOverlayState,
} from "./slotOverlay";

interface PartitionFrame {
  id: string;
  center: [number, number];
  size: [number, number];
  points: [number, number, number][];
}

interface ParkingLevelProps {
  level: ParkingLevelType;
  offset: [number, number, number];
  emphasisBias: number;
  selectedSlotId: string | null;
  hoveredSlotId: string | null;
  cameraRelevantPartitionIds: string[];
  cameraRelevantSlotIds: string[];
  activeFilters: Record<SlotStatus, boolean>;
  activeLevelIds: string[];
  activePartitionIds: string[];
  activeOverlays: SlotOverlayState;
  slotOverlayMetrics: SlotOverlayMetricsById;
  colorTuning?: SceneColorTuning;
  reducedMotion: boolean;
  onSlotHover(slotId: string | null): void;
  onSlotSelect(slotId: string): void;
}

export function ParkingLevel({
  level,
  offset,
  emphasisBias,
  selectedSlotId,
  hoveredSlotId,
  cameraRelevantPartitionIds,
  cameraRelevantSlotIds,
  activeFilters,
  activeLevelIds,
  activePartitionIds,
  activeOverlays,
  slotOverlayMetrics,
  colorTuning = DEFAULT_SCENE_COLOR_TUNING,
  reducedMotion,
  onSlotHover,
  onSlotSelect,
}: ParkingLevelProps) {
  const slotExtentX =
    Math.max(1.8, ...level.slots.map((slot) => Math.abs(slot.position[0]))) + 1.4;
  const slotExtentZ =
    Math.max(1.4, ...level.slots.map((slot) => Math.abs(slot.position[1]))) + 1.1;
  const [offsetX, offsetY, offsetZ] = offset;
  const opacityBase = 0.24 + emphasisBias * 0.46;
  const levelActive = activeLevelIds.includes(level.id);
  const visibleSlots = level.slots.filter((slot) =>
    activePartitionIds.includes(slot.partitionId),
  );
  const emphasis = levelActive ? opacityBase : opacityBase * 0.14;
  const planeFillColor = tuneHexColor("#1b2230", {
    saturation: colorTuning.saturation * 0.45,
    lightness: 0.92 + (colorTuning.lightness - 1) * 0.4,
  });
  const levelOutlineColor = tuneHexColor("#62748e", {
    saturation: Math.max(0.75, colorTuning.zoneOutlineSaturation * 0.9),
    lightness: colorTuning.zoneOutlineLightness * 1.08,
  });
  const partitionFrames = derivePartitionFrames(level);
  const visiblePartitionFrames = partitionFrames.filter((frame) =>
    activePartitionIds.includes(frame.id),
  );
  const partitionFillColor = tuneHexColor("#243247", {
    saturation: Math.max(0.78, colorTuning.zoneOutlineSaturation * 0.78),
    lightness: colorTuning.zoneOutlineLightness * 0.94,
  });
  const partitionOutlineColor = tuneHexColor("#8ea4c3", {
    saturation: Math.max(0.82, colorTuning.zoneOutlineSaturation),
    lightness: colorTuning.zoneOutlineLightness * 1.12,
  });
  const springs = useSpring({
    x: offsetX,
    y: offsetY,
    z: offsetZ,
    opacity: emphasis,
    config: reducedMotion
      ? { duration: 0 }
      : { mass: 1.2, tension: 180, friction: 28 },
  });
  const colorTuningKey = [
    colorTuning.saturation,
    colorTuning.lightness,
    colorTuning.bayOutlineSaturation,
    colorTuning.bayOutlineLightness,
    colorTuning.zoneOutlineSaturation,
    colorTuning.zoneOutlineLightness,
  ]
    .map((value) => value.toFixed(2))
    .join("-");
  const slotTransitions = useTransition(levelActive ? visibleSlots : [], {
    keys: (slot) => slot.id,
    from: {
      scale: 0.92,
      lift: -0.04,
    },
    enter: {
      scale: 1,
      lift: 0,
    },
    leave: {
      scale: 0.78,
      lift: -0.12,
    },
    expires: reducedMotion ? 0 : 80,
    config: (_item, _index, phase) =>
      reducedMotion
        ? { duration: 0 }
        : phase === "leave"
          ? { duration: 115 }
          : { mass: 1.1, tension: 215, friction: 26 },
  });
  const partitionFrameTransitions = useTransition(levelActive ? visiblePartitionFrames : [], {
    keys: (frame) => frame.id,
    from: {
      scale: 0.97,
    },
    enter: {
      scale: 1,
    },
    leave: {
      scale: 0.88,
    },
    expires: reducedMotion ? 0 : 70,
    config: (_item, _index, phase) =>
      reducedMotion
        ? { duration: 0 }
        : phase === "leave"
          ? { duration: 95 }
          : { mass: 1.05, tension: 190, friction: 24 },
  });

  return (
    <animated.group
      position-x={springs.x}
      position-y={springs.y}
      position-z={springs.z}
    >
      <mesh rotation-x={-Math.PI / 2}>
        <planeGeometry args={[slotExtentX * 2, slotExtentZ * 2]} />
        <animated.meshBasicMaterial
          color={planeFillColor}
          transparent
          opacity={springs.opacity.to((value) => value * 0.38)}
        />
      </mesh>

      <Line
        points={[
          [-slotExtentX, 0.02, -slotExtentZ],
          [slotExtentX, 0.02, -slotExtentZ],
          [slotExtentX, 0.02, slotExtentZ],
          [-slotExtentX, 0.02, slotExtentZ],
          [-slotExtentX, 0.02, -slotExtentZ],
        ]}
        color={levelOutlineColor}
        transparent
        opacity={levelActive ? 0.52 : 0.12}
        lineWidth={0.8}
      />

      {partitionFrameTransitions((style, frame) => {
        const partitionHighlighted = cameraRelevantPartitionIds.includes(frame.id);

        return (
          <animated.group
            key={frame.id}
            scale={style.scale.to((value) => [value, 1, value])}
          >
            <mesh
              position={[frame.center[0], 0.012, frame.center[1]]}
              rotation-x={-Math.PI / 2}
            >
              <planeGeometry args={frame.size} />
              <meshBasicMaterial
                color={partitionFillColor}
                transparent
                opacity={
                  levelActive
                    ? partitionHighlighted
                      ? 0.11
                      : 0.06
                    : 0.02
                }
              />
            </mesh>

            <Line
              points={frame.points}
              color={partitionOutlineColor}
              transparent
              opacity={
                levelActive
                  ? partitionHighlighted
                    ? 0.72
                    : 0.38
                  : 0.1
              }
              lineWidth={partitionHighlighted ? 1.2 : 0.72}
            />
          </animated.group>
        );
      })}

      {slotTransitions((style, slot) => (
        levelActive ? (
          <animated.group
            key={`${slot.id}:${colorTuningKey}`}
            position-x={slot.position[0]}
            position-y={style.lift.to((value) => 0.02 + value)}
            position-z={slot.position[1]}
            scale={style.scale.to((value) => [value, 1, value])}
          >
          <ParkingSlot
            id={slot.id}
            position={[0, 0]}
            size={slot.size}
            status={slot.status}
            levelOpacity={emphasis}
            highlighted={isSceneSlotHighlighted({
              slotId: slot.id,
              slotStatus: slot.status,
              selectedSlotId,
              hoveredSlotId,
              cameraRelevantSlotIds,
              activeFilters,
            })}
            hovered={hoveredSlotId === slot.id}
            selected={selectedSlotId === slot.id}
            overlays={activeOverlays}
            overlayMetric={slotOverlayMetrics[slot.id]}
            colorTuning={colorTuning}
            reducedMotion={reducedMotion}
            onHover={onSlotHover}
            onSelect={onSlotSelect}
          />
          </animated.group>
        ) : null
      ))}
    </animated.group>
  );
}

export function derivePartitionFrames(level: ParkingLevelType): PartitionFrame[] {
  const slotsByPartition = new Map<string, ParkingLevelType["slots"]>();

  for (const slot of level.slots) {
    const current = slotsByPartition.get(slot.partitionId) ?? [];
    current.push(slot);
    slotsByPartition.set(slot.partitionId, current);
  }

  return [...slotsByPartition.entries()]
    .map(([partitionId, slots]) => {
      const minX = Math.min(...slots.map((slot) => slot.position[0] - slot.size[0] / 2)) - 0.22;
      const maxX = Math.max(...slots.map((slot) => slot.position[0] + slot.size[0] / 2)) + 0.22;
      const minZ = Math.min(...slots.map((slot) => slot.position[1] - slot.size[1] / 2)) - 0.28;
      const maxZ = Math.max(...slots.map((slot) => slot.position[1] + slot.size[1] / 2)) + 0.28;

      return {
        id: partitionId,
        center: [roundSceneValue((minX + maxX) / 2), roundSceneValue((minZ + maxZ) / 2)] as [number, number],
        size: [roundSceneValue(maxX - minX), roundSceneValue(maxZ - minZ)] as [number, number],
        points: [
          [roundSceneValue(minX), 0.026, roundSceneValue(minZ)] as [number, number, number],
          [roundSceneValue(maxX), 0.026, roundSceneValue(minZ)] as [number, number, number],
          [roundSceneValue(maxX), 0.026, roundSceneValue(maxZ)] as [number, number, number],
          [roundSceneValue(minX), 0.026, roundSceneValue(maxZ)] as [number, number, number],
          [roundSceneValue(minX), 0.026, roundSceneValue(minZ)] as [number, number, number],
        ],
      };
    })
    .sort((left, right) => left.center[0] - right.center[0] || left.id.localeCompare(right.id));
}

function roundSceneValue(value: number) {
  return Number(value.toFixed(3));
}
