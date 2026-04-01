import {
  createFrameDefinition,
  getLotCameras,
  getLotLevels,
  getLotPartitions,
  syncLotDefinition,
} from "../data/lotMatrix";
import { createRectanglePolygon } from "../data/polygon";
import { createBlankLotDefinition } from "../data/starterLot";
import type {
  EditorCameraBundle,
  LiveStateSnapshot,
  LotDefinition,
  LotCameraDefinition,
  LotFrameDefinition,
  LotSlotDefinition,
  SpatialConfig,
  SpatialConfigVersionSummary,
  SpatialLineDefinition,
  SpatialZoneDefinition,
} from "../data/types";

const DEFAULT_FRAME_WIDTH = 1280;
const DEFAULT_FRAME_HEIGHT = 720;
const FRAME_SPACE_NOTE = "coord-space:frame";

export function buildEditableLotDefinition(
  bundle: EditorCameraBundle | null,
  snapshot: LiveStateSnapshot | null,
  cameraId: string,
): LotDefinition {
  if (!bundle) {
    return createBlankLotDefinition(cameraId);
  }

  return hydrateLotDefinitionForCamera(
    bundle.lotDefinition,
    snapshot,
    cameraId,
    bundle.videoSource ?? null,
  );
}

export function hydrateLotDefinitionForCamera(
  lotDefinition: LotDefinition,
  snapshot: LiveStateSnapshot | null,
  cameraId: string,
  videoSource: EditorCameraBundle["videoSource"],
): LotDefinition {
  const levels = getLotLevels(lotDefinition);
  const cameras = hydrateBundleCameras(lotDefinition, snapshot, cameraId);
  const selectedCamera =
    cameras.find((camera) => camera.id === cameraId) ??
    cameras[0] ??
    createCameraFallback(cameraId, levels[0]?.id ?? "PLANE-01");
  const frames = hydrateBundleFrames(
    lotDefinition.frames,
    snapshot,
    selectedCamera,
    videoSource ?? null,
  );
  const nextLot = syncLotDefinition({
    ...lotDefinition,
    camera: selectedCamera,
    cameras,
    frames,
  });
  const resolvedCamera =
    nextLot.cameras.find((camera) => camera.id === cameraId) ?? nextLot.camera;
  const resolvedLevel =
    nextLot.levels.find((level) => level.id === resolvedCamera.levelId) ??
    nextLot.levels[0] ??
    null;

  return {
    ...nextLot,
    camera: resolvedCamera,
    levelId: resolvedLevel?.id ?? nextLot.levelId,
    levelName: resolvedLevel?.name ?? nextLot.levelName,
    slots: hydrateBundleSlotsForCamera(nextLot, cameraId),
  };
}

function hydrateBundleSlotsForCamera(
  lotDefinition: LotDefinition,
  cameraId: string,
): LotSlotDefinition[] {
  const observationPolygonByBayId = new Map(
    lotDefinition.observationPolygons
      .filter((polygon) => polygon.cameraId === cameraId)
      .map((polygon) => [polygon.canonicalBayId, polygon] as const),
  );

  return lotDefinition.slots.map((slot) => {
    const observationPolygon = observationPolygonByBayId.get(slot.id);

    return {
      ...slot,
      imagePolygonDefined: observationPolygon !== undefined,
      imagePolygon: observationPolygon?.imagePolygon ?? createRectanglePolygon(0.5, 0.5, 0.11, 0.16),
    };
  });
}

export function lotDefinitionToSpatialConfig(
  lotDefinition: LotDefinition,
  options: {
    cameraId?: string;
    version: number;
    status: SpatialConfig["status"];
    baseConfig?: SpatialConfig | null;
    createdAt?: string;
    updatedAt?: string;
    activatedAt?: string | null;
  },
): SpatialConfig {
  const now = new Date().toISOString();
  const cameraId = options.cameraId ?? lotDefinition.camera.id;
  const selectedCamera =
    getLotCameras(lotDefinition).find((camera) => camera.id === cameraId) ??
    lotDefinition.camera;
  const zones = buildZones(lotDefinition);
  const lines = buildLines(getLotCameras(lotDefinition), options.baseConfig?.lines ?? []);
  const baseBaysById = new Map((options.baseConfig?.bays ?? []).map((bay) => [bay.id, bay] as const));
  const observationPolygons = mergeObservationPolygons(
    lotDefinition,
    cameraId,
    options.version,
    options.baseConfig ?? null,
  );
  const observationCameraIdsByBayId = new Map<string, string[]>();
  for (const polygon of observationPolygons) {
    const existing = observationCameraIdsByBayId.get(polygon.canonicalBayId) ?? [];
    if (!existing.includes(polygon.cameraId)) {
      existing.push(polygon.cameraId);
      observationCameraIdsByBayId.set(polygon.canonicalBayId, existing);
    }
  }

  return {
    facilityId: lotDefinition.facilityId,
    facilityName: lotDefinition.facilityName,
    timeZone: lotDefinition.timeZone,
    cameraId: selectedCamera.id,
    frameWidth: lotDefinition.frames[0]?.width ?? options.baseConfig?.frameWidth ?? DEFAULT_FRAME_WIDTH,
    frameHeight: lotDefinition.frames[0]?.height ?? options.baseConfig?.frameHeight ?? DEFAULT_FRAME_HEIGHT,
    sourceLotKey: lotDefinition.sourceLotKey,
    version: options.version,
    status: options.status,
    countingEnabled: lines.some((line) => line.enabled),
    createdAt: options.createdAt ?? now,
    updatedAt: options.updatedAt ?? now,
    activatedAt: options.activatedAt ?? null,
    presetName: selectedCamera.name,
    levels: getLotLevels(lotDefinition),
    camera: selectedCamera,
    cameras: getLotCameras(lotDefinition),
    frames: lotDefinition.frames,
    partitions: lotDefinition.partitions.length > 0 ? lotDefinition.partitions : getLotPartitions(lotDefinition),
    observationPolygons,
    bays: lotDefinition.slots.map((slot) => {
      const existingBay = baseBaysById.get(slot.id);
      const observationCameraIds = observationCameraIdsByBayId.get(slot.id) ?? [];
      const sourceCameraIds =
        observationCameraIds.length > 0
          ? observationCameraIds
          : Array.from(
              new Set(
                [
                  ...(existingBay?.sourceCameraIds ?? []),
                  ...(slot.ownerCameraIds ?? []),
                  slot.cameraId,
                ].filter(Boolean),
              ),
            );
      const resolvedCameraId = observationCameraIds[0] ?? slot.cameraId;

      return {
        id: slot.id,
        label: slot.label,
        levelId: slot.levelId,
        partitionId: slot.partitionId,
        cameraId: resolvedCameraId,
        sourceCameraIds,
        row: slot.row,
        column: slot.column,
        zoneId: slot.zoneId ?? slot.levelId,
        imagePolygon: existingBay?.imagePolygon ?? slot.imagePolygon,
        layoutPolygon: slot.layoutPolygon,
        evCapable: slot.evCapable,
        reservedDefault: slot.reservedDefault,
      };
    }),
    zones,
    lines,
    countingLines: options.baseConfig?.countingLines ?? [],
    densityZones: options.baseConfig?.densityZones ?? [],
    countingAlertRules: options.baseConfig?.countingAlertRules ?? [],
  };
}

export function summarizeSpatialConfigVersion(config: SpatialConfig): SpatialConfigVersionSummary {
  return {
    cameraId: config.cameraId,
    version: config.version,
    status: config.status,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
    bayCount: config.bays.length,
    zoneCount: config.zones.length,
    lineCount: config.lines.length,
    countingLineCount: config.countingLines?.length ?? 0,
    densityZoneCount: config.densityZones?.length ?? 0,
  };
}

export function getMaxVersion(versions: SpatialConfigVersionSummary[]) {
  return versions.reduce((max, entry) => Math.max(max, entry.version), 0);
}

export function cloneLotDefinition(lotDefinition: LotDefinition): LotDefinition {
  return structuredClone(lotDefinition);
}

export function syncEditableObservationPolygonsForCamera(
  lotDefinition: LotDefinition,
  cameraId: string,
  presetVersion: number,
): LotDefinition {
  return syncLotDefinition({
    ...lotDefinition,
    observationPolygons: mergeObservationPolygons(
      lotDefinition,
      cameraId,
      presetVersion,
      null,
    ),
  });
}

function hydrateBundleCameras(
  lotDefinition: LotDefinition,
  snapshot: LiveStateSnapshot | null,
  cameraId: string,
): LotCameraDefinition[] {
  const baseCameras = getLotCameras(lotDefinition);
  const byId = new Map(baseCameras.map((camera) => [camera.id, camera] as const));

  for (const snapshotCamera of snapshot?.cameras ?? []) {
    const existing = byId.get(snapshotCamera.id);
    byId.set(snapshotCamera.id, {
      id: snapshotCamera.id,
      name: snapshotCamera.name,
      levelId: existing?.levelId ?? snapshotCamera.levelId ?? baseCameras[0]?.levelId ?? lotDefinition.levelId,
      location: snapshotCamera.location ?? existing?.location ?? "Calibrated editor view",
      angle: snapshotCamera.angle ?? existing?.angle ?? "fixed view",
    });
  }

  if (!byId.has(cameraId)) {
    byId.set(
      cameraId,
      createCameraFallback(cameraId, baseCameras[0]?.levelId ?? lotDefinition.levelId),
    );
  }

  return [...byId.values()];
}

function hydrateBundleFrames(
  frames: LotDefinition["frames"],
  snapshot: LiveStateSnapshot | null,
  selectedCamera: LotCameraDefinition,
  videoSource: EditorCameraBundle["videoSource"],
): LotFrameDefinition[] {
  const selectedFrames = frames.filter((frame) => frame.cameraId === selectedCamera.id);
  const snapshotCamera =
    snapshot?.cameras.find((camera) => camera.id === selectedCamera.id) ?? null;
  const width =
    snapshotCamera?.imageWidth ??
    videoSource?.width ??
    selectedFrames[0]?.width ??
    frames[0]?.width ??
    DEFAULT_FRAME_WIDTH;
  const height =
    snapshotCamera?.imageHeight ??
    videoSource?.height ??
    selectedFrames[0]?.height ??
    frames[0]?.height ??
    DEFAULT_FRAME_HEIGHT;

  if (selectedFrames.length > 0) {
    return selectedFrames.map((frame, index) =>
      index === 0 && snapshotCamera
        ? {
            ...frame,
            label: snapshotCamera.frameLabel ?? frame.label,
            imagePath: snapshotCamera.frameUrl ?? snapshotCamera.thumbnail ?? frame.imagePath,
            capturedAt: snapshotCamera.timestamp ?? frame.capturedAt,
            width,
            height,
          }
        : frame,
    );
  }

  const sourceFrames =
    frames.length > 0
      ? frames
      : Array.from(
          { length: Math.max(1, Math.min(videoSource?.frameCount ?? 1, 6)) },
          (_, index) => createFrameDefinition(selectedCamera.id, index),
        );

  return sourceFrames.map((frame, index) =>
    createFrameDefinition(selectedCamera.id, index, {
      id:
        index === 0 && snapshotCamera?.frameId
          ? snapshotCamera.frameId
          : `${selectedCamera.id}-frame-${String(index + 1).padStart(2, "0")}`,
      label:
        index === 0
          ? snapshotCamera?.frameLabel ?? frame.label ?? `Capture ${index + 1}`
          : frame.label ?? `Capture ${index + 1}`,
      imagePath:
        index === 0
          ? snapshotCamera?.frameUrl ?? snapshotCamera?.thumbnail ?? frame.imagePath ?? null
          : frame.imagePath ?? null,
      capturedAt:
        index === 0
          ? snapshotCamera?.timestamp ?? frame.capturedAt
          : frame.capturedAt,
      width,
      height,
    }),
  );
}

function mergeObservationPolygons(
  lotDefinition: LotDefinition,
  currentCameraId: string,
  presetVersion: number,
  baseConfig: SpatialConfig | null,
) {
  const sourcePolygons = baseConfig?.observationPolygons ?? lotDefinition.observationPolygons;
  const slotIds = new Set(lotDefinition.slots.map((slot) => slot.id));
  const existingPolygonsByBayId = new Map(
    sourcePolygons
      .filter((polygon) => polygon.cameraId === currentCameraId)
      .map((polygon) => [polygon.canonicalBayId, polygon] as const),
  );
  const preservedPolygons = sourcePolygons.filter(
    (polygon) => polygon.cameraId !== currentCameraId && slotIds.has(polygon.canonicalBayId),
  );
  const currentCameraPolygons = lotDefinition.slots
    .filter((slot) => slot.imagePolygonDefined !== false)
    .map((slot) => {
    const existing = existingPolygonsByBayId.get(slot.id);

    return {
      id: existing?.id ?? `obs-${currentCameraId}-${slot.id}`,
      cameraId: currentCameraId,
      presetVersion,
      canonicalBayId: slot.id,
      imagePolygon: slot.imagePolygon,
      enabled: existing?.enabled ?? true,
      priority: existing?.priority ?? 1,
      notes: withFrameSpaceNote(existing?.notes ?? null),
    };
    });
  const currentCameraPolygonBayIds = new Set(
    currentCameraPolygons.map((polygon) => polygon.canonicalBayId),
  );

  return [
    ...preservedPolygons.filter(
      (polygon) => !currentCameraPolygonBayIds.has(polygon.canonicalBayId),
    ),
    ...currentCameraPolygons,
  ];
}

function withFrameSpaceNote(notes: string | null) {
  if (notes?.includes(FRAME_SPACE_NOTE)) {
    return notes;
  }

  return notes ? `${notes} ${FRAME_SPACE_NOTE}` : FRAME_SPACE_NOTE;
}

function buildZones(lotDefinition: LotDefinition): SpatialZoneDefinition[] {
  return getLotPartitions(lotDefinition).map((partition) => {
    const partitionSlots = lotDefinition.slots.filter((slot) => slot.partitionId === partition.id);
    const polygon = polygonFromSlots(partitionSlots);

    return {
      id: partition.id,
      label: partition.name,
      levelId: partition.levelId,
      bayIds: partitionSlots.map((slot) => slot.id),
      imagePolygon: polygon,
      layoutPolygon: polygonFromSlots(partitionSlots, "layoutPolygon"),
    };
  });
}

function buildLines(
  cameras: LotCameraDefinition[],
  existingLines: SpatialLineDefinition[],
): SpatialLineDefinition[] {
  if (existingLines.length > 0) {
    return existingLines;
  }

  return cameras.flatMap((camera) => [
    {
      id: `${camera.id}-LINE-ENTRY`,
      label: "Entry",
      cameraId: camera.id,
      kind: "entry",
      enabled: true,
      points: [
        [0.14, 0.22],
        [0.86, 0.22],
      ],
      layoutPoints: [
        [0.14, 0.22],
        [0.86, 0.22],
      ],
    },
    {
      id: `${camera.id}-LINE-EXIT`,
      label: "Exit",
      cameraId: camera.id,
      kind: "exit",
      enabled: true,
      points: [
        [0.18, 0.78],
        [0.82, 0.78],
      ],
      layoutPoints: [
        [0.18, 0.78],
        [0.82, 0.78],
      ],
    },
  ]);
}

function createCameraFallback(cameraId: string, levelId: string): LotCameraDefinition {
  return {
    id: cameraId,
    name: cameraId,
    levelId,
    location: "Calibrated editor view",
    angle: "fixed view",
  };
}

function polygonFromSlots(
  slots: LotSlotDefinition[],
  key: "imagePolygon" | "layoutPolygon" = "imagePolygon",
) {
  const points = slots.flatMap((slot) => slot[key] ?? []);
  if (points.length === 0) {
    return createRectanglePolygon(0.5, 0.5, 0.8, 0.8);
  }

  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const left = Math.max(0.02, Math.min(...xs) - 0.03);
  const right = Math.min(0.98, Math.max(...xs) + 0.03);
  const top = Math.max(0.02, Math.min(...ys) - 0.03);
  const bottom = Math.min(0.98, Math.max(...ys) + 0.03);

  return [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ] as [number, number][];
}
