import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
import { Vector3 } from "three";
import { findSlotById } from "../data/dashboardUtils";
import type { ParkingLevel, SlotStatus } from "../data/types";
import { deriveLevelPlacements, ParkingCube } from "./ParkingCube";
import { SceneControls } from "./SceneControls";
import {
  DEFAULT_SCENE_COLOR_TUNING,
  type SceneColorTuning,
  type SlotOverlayMetricsById,
  type SlotOverlayState,
} from "./slotOverlay";

interface ProjectedPoint {
  x: number;
  y: number;
}

export interface ParkingSceneProps {
  levels: ParkingLevel[];
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
  zoomFactor?: number;
  reducedMotion: boolean;
  onSlotHover(slotId: string | null): void;
  onSlotSelect(slotId: string): void;
  onSelectedSlotProject(point: ProjectedPoint | null): void;
}

interface SceneBounds {
  maxX: number;
  maxZ: number;
  verticalSpan: number;
  cameraPosition: [number, number, number];
  initialTarget: [number, number, number];
}

export function ParkingScene({
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
  zoomFactor = 1,
  reducedMotion,
  onSlotHover,
  onSlotSelect,
  onSelectedSlotProject,
}: ParkingSceneProps) {
  const sceneBounds = useMemo(() => deriveSceneBounds(levels, zoomFactor), [levels, zoomFactor]);
  const [initialCameraPosition] = useState<[number, number, number]>(() => sceneBounds.cameraPosition);
  const levelPlacements = useMemo(() => deriveLevelPlacements(levels), [levels]);
  const levelPlacementById = useMemo(
    () => new Map(levelPlacements.map((placement) => [placement.levelId, placement.offset])),
    [levelPlacements],
  );
  const selectedSlot = useMemo(
    () => findSlotById(levels, selectedSlotId),
    [levels, selectedSlotId],
  );

  useEffect(() => {
    return () => {
      onSelectedSlotProject(null);
    };
  }, [onSelectedSlotProject]);

  return (
    <Canvas
      className="parking-canvas"
      gl={{ antialias: true, alpha: true }}
      dpr={[1, 2]}
      onPointerMissed={() => onSlotHover(null)}
    >
      <PerspectiveCamera makeDefault position={initialCameraPosition} fov={32} />
      <fog attach="fog" args={["#07090d", 18, 31]} />
      <ambientLight intensity={0.78} color="#b6c5d8" />
      <directionalLight position={[6, 10, 8]} intensity={1.22} color="#e5edf8" />
      <pointLight position={[-8, 4, -10]} intensity={0.62} color="#6f84a5" />

      <ParkingCube
        levels={levels}
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

      <SelectedSlotTracker
        slot={selectedSlot}
        levelOffsets={levelPlacementById}
        onSelectedSlotProject={onSelectedSlotProject}
      />

      <SceneControls
      maxX={sceneBounds.maxX}
      maxZ={sceneBounds.maxZ}
      verticalSpan={sceneBounds.verticalSpan}
      initialTarget={sceneBounds.initialTarget}
      />
    </Canvas>
  );
}

function deriveSceneBounds(levels: ParkingLevel[], zoomFactor: number): SceneBounds {
  const placements = deriveLevelPlacements(levels);
  const placementByLevelId = new Map(placements.map((placement) => [placement.levelId, placement.offset]));
  const slots = levels.flatMap((level) => {
    const [offsetX, , offsetZ] = placementByLevelId.get(level.id) ?? [0, 0, 0];
    return level.slots.map((slot) => ({
      ...slot,
      position: [slot.position[0] + offsetX, slot.position[1] + offsetZ] as [number, number],
    }));
  });
  if (slots.length === 0) {
    return {
      maxX: 2,
      maxZ: 1.8,
      verticalSpan: 2.2,
      cameraPosition: [1.2, 11.2, 1.5],
      initialTarget: [0, 0.75, 0],
    };
  }

  const maxX =
    Math.max(
      1.35,
      ...slots.map((slot) => Math.abs(slot.position[0]) + slot.size[0] / 2),
    ) + 0.7;
  const maxZ =
    Math.max(
      1.15,
      ...slots.map((slot) => Math.abs(slot.position[1]) + slot.size[1] / 2),
    ) + 0.6;
  const elevations = levels.map((level) => level.elevation);
  const minElevation = elevations.length > 0 ? Math.min(...elevations) : 0;
  const maxElevation = elevations.length > 0 ? Math.max(...elevations) : 0;
  const verticalSpan = Math.max(2, maxElevation - minElevation + 1.1);
  const sceneRadius = Math.max(maxX, maxZ);

  const clampedZoom = Math.min(Math.max(zoomFactor, 0.65), 1.75);

  return {
    maxX,
    maxZ,
    verticalSpan,
    cameraPosition: [
      sceneRadius * 0.34 * clampedZoom,
      (verticalSpan + sceneRadius * 1.72 + 1.1) * clampedZoom,
      sceneRadius * 1.82 * clampedZoom,
    ],
    initialTarget: [
      0,
      Math.max(0.58, verticalSpan * 0.14),
      sceneRadius * 0.12,
    ],
  };
}

function SelectedSlotTracker({
  slot,
  levelOffsets,
  onSelectedSlotProject,
}: {
  slot: ReturnType<typeof findSlotById>;
  levelOffsets: Map<string, [number, number, number]>;
  onSelectedSlotProject(point: ProjectedPoint | null): void;
}) {
  const { camera, size } = useThree();
  const vectorRef = useRef(new Vector3());
  const lastPointRef = useRef<ProjectedPoint | null>(null);

  useFrame(() => {
    if (!slot) {
      if (lastPointRef.current) {
        lastPointRef.current = null;
        onSelectedSlotProject(null);
      }

      return;
    }

    vectorRef.current.set(
      slot.position[0] + (levelOffsets.get(slot.levelId)?.[0] ?? 0),
      (levelOffsets.get(slot.levelId)?.[1] ?? 0) + 0.22,
      slot.position[1] + (levelOffsets.get(slot.levelId)?.[2] ?? 0),
    );
    vectorRef.current.project(camera);

    if (vectorRef.current.z < -1 || vectorRef.current.z > 1) {
      return;
    }

    const nextPoint = {
      x: (vectorRef.current.x * 0.5 + 0.5) * size.width,
      y: (-vectorRef.current.y * 0.5 + 0.5) * size.height,
    };

    if (
      !lastPointRef.current ||
      Math.abs(lastPointRef.current.x - nextPoint.x) > 1 ||
      Math.abs(lastPointRef.current.y - nextPoint.y) > 1
    ) {
      lastPointRef.current = nextPoint;
      onSelectedSlotProject(nextPoint);
    }
  });

  return null;
}
