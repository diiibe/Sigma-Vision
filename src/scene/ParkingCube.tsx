import { Line } from "@react-three/drei";
import type { ParkingLevel as ParkingLevelType, SlotStatus } from "../data/types";
import { ParkingLevel } from "./ParkingLevel";
import {
  DEFAULT_SCENE_COLOR_TUNING,
  tuneHexColor,
  type SceneColorTuning,
  type SlotOverlayMetricsById,
  type SlotOverlayState,
} from "./slotOverlay";

interface ParkingCubeProps {
  levels: ParkingLevelType[];
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

export const LEVEL_SEPARATION = 1.76;

export interface LevelPlacement {
  levelId: string;
  offset: [number, number, number];
}

export function deriveLevelPlacements(levels: ParkingLevelType[]): LevelPlacement[] {
  const groups = new Map<number, ParkingLevelType[]>();
  for (const level of levels) {
    const key = level.index;
    const current = groups.get(key) ?? [];
    current.push(level);
    groups.set(key, current);
  }

  const elevations = levels.map((level) => level.elevation);
  const minElevation = elevations.length > 0 ? Math.min(...elevations) : 0;
  const maxElevation = elevations.length > 0 ? Math.max(...elevations) : 0;
  const centerElevation = (minElevation + maxElevation) / 2;
  const placements: LevelPlacement[] = [];

  for (const level of [...levels].sort((left, right) => left.index - right.index || left.id.localeCompare(right.id))) {
    const peers = [...(groups.get(level.index) ?? [level])].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const peerIndex = peers.findIndex((entry) => entry.id === level.id);
    const columns = Math.max(1, Math.ceil(Math.sqrt(peers.length)));
    const rows = Math.max(1, Math.ceil(peers.length / columns));
    const row = Math.floor(peerIndex / columns);
    const column = peerIndex % columns;
    const blockWidth =
      Math.max(
        3.2,
        ...peers.map((entry) =>
          Math.max(
            1.6,
            ...entry.slots.map((slot) => Math.abs(slot.position[0]) + slot.size[0] / 2),
          ) * 2 + 2.1,
        ),
      );
    const blockDepth =
      Math.max(
        2.8,
        ...peers.map((entry) =>
          Math.max(
            1.4,
            ...entry.slots.map((slot) => Math.abs(slot.position[1]) + slot.size[1] / 2),
          ) * 2 + 2.4,
        ),
      );
    const offsetX = (column - (columns - 1) / 2) * blockWidth;
    const offsetZ = (row - (rows - 1) / 2) * blockDepth;

    placements.push({
      levelId: level.id,
      offset: [offsetX, level.elevation - centerElevation, offsetZ],
    });
  }

  return placements;
}

export function ParkingCube({
  levels,
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
}: ParkingCubeProps) {
  const placements = deriveLevelPlacements(levels);
  const placementByLevelId = new Map(placements.map((placement) => [placement.levelId, placement.offset]));
  const slotExtents = levels.flatMap((level) => {
    const [offsetX, , offsetZ] = placementByLevelId.get(level.id) ?? [0, 0, 0];
    return level.slots.map((slot) => ({
      minX: offsetX + slot.position[0] - slot.size[0] / 2,
      maxX: offsetX + slot.position[0] + slot.size[0] / 2,
      minZ: offsetZ + slot.position[1] - slot.size[1] / 2,
      maxZ: offsetZ + slot.position[1] + slot.size[1] / 2,
    }));
  });
  const maxX =
    Math.max(
      1.35,
      ...slotExtents.map((extent) => Math.max(Math.abs(extent.minX), Math.abs(extent.maxX))),
    ) + 0.7;
  const maxZ =
    Math.max(
      1.15,
      ...slotExtents.map((extent) => Math.max(Math.abs(extent.minZ), Math.abs(extent.maxZ))),
    ) + 0.6;
  const elevations = levels.map((level) => level.elevation);
  const minElevation = elevations.length > 0 ? Math.min(...elevations) : 0;
  const maxElevation = elevations.length > 0 ? Math.max(...elevations) : 0;
  const centerElevation = (minElevation + maxElevation) / 2;
  const elevationSpan = Math.max(maxElevation - minElevation, 0.001);
  const height = Math.max(elevationSpan + 1.15, 1.15);
  const halfHeight = height / 2;
  const gridSize = Math.max(8, Math.ceil(Math.max(maxX, maxZ) * 2.1));
  const gridDivisions = Math.max(10, Math.round(gridSize * 0.82));
  const gridMajor = tuneHexColor("#314258", {
    saturation: Math.max(0.7, colorTuning.zoneOutlineSaturation * 0.85),
    lightness: colorTuning.zoneOutlineLightness * 1.1,
  });
  const gridMinor = tuneHexColor("#1a2230", {
    saturation: Math.max(0.55, colorTuning.zoneOutlineSaturation * 0.75),
    lightness: colorTuning.zoneOutlineLightness,
  });
  const frameLine = tuneHexColor("#5f7391", {
    saturation: Math.max(0.75, colorTuning.zoneOutlineSaturation * 0.9),
    lightness: colorTuning.zoneOutlineLightness * 1.08,
  });
  const corners = [
    [-maxX, -halfHeight, -maxZ],
    [maxX, -halfHeight, -maxZ],
    [maxX, -halfHeight, maxZ],
    [-maxX, -halfHeight, maxZ],
  ] as const;

  return (
    <group>
      <gridHelper
        args={[gridSize, gridDivisions, gridMajor, gridMinor]}
        position={[0, -halfHeight - 0.62, 0]}
      />

      {corners.map((corner, index) => (
        <Line
          key={index}
          points={[
            [corner[0], -halfHeight, corner[2]],
            [corner[0], halfHeight, corner[2]],
          ]}
          color={frameLine}
          transparent
          opacity={0.34}
          lineWidth={0.6}
        />
      ))}

      {levels.map((level) => (
        <ParkingLevel
          key={level.id}
          level={level}
          offset={placementByLevelId.get(level.id) ?? [0, level.elevation - centerElevation, 0]}
          emphasisBias={(level.elevation - minElevation) / elevationSpan}
          selectedSlotId={selectedSlotId}
          hoveredSlotId={hoveredSlotId}
          cameraRelevantPartitionIds={cameraRelevantPartitionIds}
          cameraRelevantSlotIds={cameraRelevantSlotIds}
          activeFilters={activeFilters}
          activeLevelIds={activeLevelIds}
          activePartitionIds={activePartitionIds}
          activeOverlays={activeOverlays}
          slotOverlayMetrics={slotOverlayMetrics}
          colorTuning={colorTuning}
          reducedMotion={reducedMotion}
          onSlotHover={onSlotHover}
          onSlotSelect={onSlotSelect}
        />
      ))}
    </group>
  );
}
