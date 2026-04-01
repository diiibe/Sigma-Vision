import { createRectanglePolygon } from "./polygon";
import type {
  LayoutPartitionDefinition,
  LotDefinition,
  LotCameraDefinition,
  LotFrameDefinition,
  LotLevelDefinition,
  LotSlotDefinition,
} from "./types";

const SLOT_WIDTH = 1.04;
const SLOT_DEPTH = 0.58;
const COLUMN_SPACING = 1.34;
const ROW_SPACING = 2.12;
const LAYOUT_MARGIN_X = 0.12;
const LAYOUT_MARGIN_Y = 0.18;
const LAYOUT_WIDTH = 0.76;
const LAYOUT_HEIGHT = 0.54;
const PARTITION_GAP = 0.04;

export function getLotLevels(lotDefinition: LotDefinition): LotLevelDefinition[] {
  if (lotDefinition.levels.length > 0) {
    return [...lotDefinition.levels].sort((left, right) => left.index - right.index);
  }

  return [
    {
      id: lotDefinition.levelId,
      name: lotDefinition.levelName,
      index: 0,
      gridRows: 1,
      gridColumns: 4,
    },
  ];
}

export function getLotCameras(lotDefinition: LotDefinition): LotCameraDefinition[] {
  const cameras = lotDefinition.cameras ?? [];

  if (cameras.length > 0) {
    return [...cameras];
  }

  if (lotDefinition.camera) {
    return [lotDefinition.camera];
  }

  return [
    {
      id: "CAM-01",
      name: "Camera 01",
      levelId: lotDefinition.levelId,
      location: "Unassigned",
      angle: "fixed view",
    },
  ];
}

export function getLotPartitions(lotDefinition: LotDefinition): LayoutPartitionDefinition[] {
  const partitions = lotDefinition.partitions ?? [];
  if (partitions.length > 0) {
    return [...partitions].sort(
      (left, right) =>
        left.levelId.localeCompare(right.levelId) ||
        left.order - right.order ||
        left.name.localeCompare(right.name),
    );
  }

  return getLotLevels(lotDefinition).map((level, index) => ({
    id: level.id,
    name: level.name,
    levelId: level.id,
    order: index,
    gridRows: level.gridRows,
    gridColumns: level.gridColumns,
    ownerCameraIds: [],
    layoutPolygon: null,
  }));
}

export function syncLotDefinition(lotDefinition: LotDefinition): LotDefinition {
  const levels = getLotLevels(lotDefinition).map((level) => {
    return {
      ...level,
      gridRows: Math.max(level.gridRows ?? 1, 1),
      gridColumns: Math.max(level.gridColumns ?? 1, 1),
    };
  });
  const cameras = normalizeCameras(getLotCameras(lotDefinition), levels);
  const partitions = normalizePartitions(getLotPartitions(lotDefinition), levels);
  const frames = normalizeFrames(lotDefinition.frames, cameras);
  const slots = normalizeSlots(lotDefinition.slots, levels, partitions, cameras).map((slot) => ({
    ...slot,
    layoutPolygon: deriveLayoutPolygon(slot, partitions),
  }));
  const primaryCamera =
    cameras.find((camera) => camera.id === lotDefinition.camera?.id) ??
    cameras[0];

  return {
    ...lotDefinition,
    levelId: levels[0]?.id ?? lotDefinition.levelId,
    levelName: levels[0]?.name ?? lotDefinition.levelName,
    levels,
    camera: primaryCamera,
    cameras,
    frames,
    partitions,
    observationPolygons: lotDefinition.observationPolygons ?? [],
    slots,
  };
}

function normalizeCameras(
  cameras: LotCameraDefinition[],
  levels: LotLevelDefinition[],
) {
  const levelIds = new Set(levels.map((level) => level.id));
  const fallbackLevelId = levels[0]?.id ?? "";

  return cameras.map((camera, index) => ({
    ...camera,
    id: camera.id || createCameraId(index),
    name: camera.name || `Camera ${String(index + 1).padStart(2, "0")}`,
    levelId: levelIds.has(camera.levelId) ? camera.levelId : fallbackLevelId,
  }));
}

function normalizeFrames(
  frames: LotFrameDefinition[],
  cameras: LotCameraDefinition[],
) {
  const fallbackCameraId = cameras[0]?.id ?? "CAM-01";
  const cameraIds = new Set(cameras.map((camera) => camera.id));

  return frames.map((frame) => ({
    ...frame,
    cameraId: frame.cameraId && cameraIds.has(frame.cameraId) ? frame.cameraId : fallbackCameraId,
  }));
}

function normalizePartitions(
  partitions: LayoutPartitionDefinition[],
  levels: LotLevelDefinition[],
) {
  const levelIds = new Set(levels.map((level) => level.id));
  const levelNames = new Map(levels.map((level) => [level.id, level.name.trim().toLowerCase()] as const));
  const fallbackLevelId = levels[0]?.id ?? "";
  const nextOrderByLevel = new Map<string, number>();

  return partitions.map((partition) => {
    const levelId = levelIds.has(partition.levelId) ? partition.levelId : fallbackLevelId;
    const fallbackOrder = nextOrderByLevel.get(levelId) ?? 0;
    nextOrderByLevel.set(levelId, fallbackOrder + 1);
    const normalizedName = normalizePartitionName(partition.name, fallbackOrder, levelNames.get(levelId));

    return {
      ...partition,
      name: normalizedName,
      levelId,
      order: Number.isFinite(partition.order) ? partition.order : fallbackOrder,
      gridRows: Math.max(partition.gridRows ?? 1, 1),
      gridColumns: Math.max(partition.gridColumns ?? 1, 1),
      ownerCameraIds: partition.ownerCameraIds ?? [],
    };
  });
}

function normalizePartitionName(
  name: string | undefined,
  order: number,
  levelName: string | undefined,
) {
  const fallbackName = `Zone ${String(order + 1).padStart(2, "0")}`;
  const trimmedName = name?.trim() ?? "";
  const normalizedName = trimmedName.toLowerCase();

  if (
    !trimmedName ||
    normalizedName === levelName ||
    /^plane\s+\d+/i.test(trimmedName) ||
    /^partition\s+\d+/i.test(trimmedName)
  ) {
    return fallbackName;
  }

  return trimmedName;
}

function normalizeSlots(
  slots: LotSlotDefinition[],
  levels: LotLevelDefinition[],
  partitions: LayoutPartitionDefinition[],
  cameras: LotCameraDefinition[],
) {
  const normalizedLevels = new Map(levels.map((level) => [level.id, level] as const));
  const fallbackLevelId = levels[0]?.id ?? "";
  const partitionIds = new Set(partitions.map((partition) => partition.id));
  const fallbackPartitionId = partitions[0]?.id ?? fallbackLevelId;
  const cameraIds = new Set(cameras.map((camera) => camera.id));
  const fallbackCameraId = cameras[0]?.id ?? "CAM-01";
  const normalizedSlots = slots.map((slot) => ({
    ...slot,
    levelId: normalizedLevels.has(slot.levelId) ? slot.levelId : fallbackLevelId,
    partitionId:
      slot.partitionId && partitionIds.has(slot.partitionId)
        ? slot.partitionId
        : firstPartitionForLevel(slot.levelId, partitions)?.id ?? fallbackPartitionId,
    cameraId: cameraIds.has(slot.cameraId) ? slot.cameraId : fallbackCameraId,
  }));

  return partitions.flatMap((partition) => {
    const partitionSlots = normalizedSlots
      .filter((slot) => slot.partitionId === partition.id)
      .sort(
        (left, right) =>
          left.row - right.row ||
          left.column - right.column ||
          left.label.localeCompare(right.label) ||
          left.id.localeCompare(right.id),
      );
    const occupied = new Set<string>();

    return partitionSlots.map((slot) => {
      const [row, column] = placeSlot(partition, slot, occupied);
      occupied.add(`${row}:${column}`);

      return {
        ...slot,
        levelId: partition.levelId,
        row,
        column,
      };
    });
  });
}

function placeSlot(
  partition: LayoutPartitionDefinition,
  slot: LotSlotDefinition,
  occupied: Set<string>,
): [number, number] {
  const rows = Math.max(partition.gridRows, 1);
  const columns = Math.max(partition.gridColumns, 1);
  const clampedRow = clampIndex(slot.row, rows);
  const clampedColumn = clampIndex(slot.column, columns);
  const preferredKey = `${clampedRow}:${clampedColumn}`;

  if (!occupied.has(preferredKey)) {
    return [clampedRow, clampedColumn];
  }

  const preferredIndex = clampedRow * columns + clampedColumn;

  for (let offset = 0; offset < rows * columns; offset += 1) {
    const index = (preferredIndex + offset) % (rows * columns);
    const row = Math.floor(index / columns);
    const column = index % columns;
    const key = `${row}:${column}`;

    if (!occupied.has(key)) {
      return [row, column];
    }
  }

  return [clampedRow, clampedColumn];
}

function clampIndex(value: number, size: number) {
  return Math.min(Math.max(0, value), Math.max(size - 1, 0));
}

export function deriveMatrixSlotPosition(
  row: number,
  column: number,
  rows: number,
  columns: number,
): [number, number] {
  const xOffset = -((Math.max(columns, 1) - 1) * COLUMN_SPACING) / 2;
  const zOffset = -((Math.max(rows, 1) - 1) * ROW_SPACING) / 2;

  return [
    roundPosition(xOffset + column * COLUMN_SPACING),
    roundPosition(zOffset + row * ROW_SPACING),
  ];
}

export function deriveMatrixSlotSize(): [number, number] {
  return [SLOT_WIDTH, SLOT_DEPTH];
}

export function createLevelDefinition(index: number): LotLevelDefinition {
  return {
    id: `PLANE-${String(index + 1).padStart(2, "0")}`,
    name: `Plane ${String(index + 1).padStart(2, "0")}`,
    index,
    gridRows: 1,
    gridColumns: 4,
  };
}

export function createCameraDefinition(index: number, levelId: string): LotCameraDefinition {
  return {
    id: createCameraId(index),
    name: `Camera ${String(index + 1).padStart(2, "0")}`,
    levelId,
    location: "Calibrated editor view",
    angle: "fixed view",
  };
}

export function createFrameDefinition(
  cameraId: string,
  index: number,
  template?: Partial<LotFrameDefinition>,
): LotFrameDefinition {
  return {
    id: template?.id ?? `${cameraId}-frame-${String(index + 1).padStart(2, "0")}`,
    cameraId,
    label: template?.label ?? `Capture ${index + 1}`,
    imagePath: template?.imagePath ?? null,
    capturedAt: template?.capturedAt ?? new Date(Date.UTC(2026, 2, 13, 9, 0, index * 5)).toISOString(),
    width: template?.width ?? 1280,
    height: template?.height ?? 720,
  };
}

function deriveLayoutPolygon(
  slot: LotSlotDefinition,
  partitions: LayoutPartitionDefinition[],
) {
  const partition = partitions.find((entry) => entry.id === slot.partitionId);
  const rows = Math.max(partition?.gridRows ?? 1, 1);
  const columns = Math.max(partition?.gridColumns ?? 1, 1);
  const frame = derivePartitionFrame(partition, partitions);
  const cellWidth = frame.width / Math.max(columns, 1);
  const cellHeight = frame.height / Math.max(rows, 1);
  const centerX = frame.left + cellWidth * (slot.column + 0.5);
  const centerY = frame.top + cellHeight * (slot.row + 0.5);
  const width = Math.min(0.12, cellWidth * 0.74);
  const height = Math.min(0.17, cellHeight * 0.62);

  return createRectanglePolygon(centerX, centerY, width, height);
}

function firstPartitionForLevel(
  levelId: string,
  partitions: LayoutPartitionDefinition[],
) {
  return partitions
    .filter((partition) => partition.levelId === levelId)
    .sort((left, right) => left.order - right.order)[0];
}

function derivePartitionFrame(
  partition: LayoutPartitionDefinition | undefined,
  partitions: LayoutPartitionDefinition[],
) {
  if (!partition) {
    return {
      left: LAYOUT_MARGIN_X,
      top: LAYOUT_MARGIN_Y,
      width: LAYOUT_WIDTH,
      height: LAYOUT_HEIGHT,
    };
  }

  const peers = partitions
    .filter((entry) => entry.levelId === partition.levelId)
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
  const index = Math.max(peers.findIndex((entry) => entry.id === partition.id), 0);
  const totalGap = PARTITION_GAP * Math.max(peers.length - 1, 0);
  const width = (LAYOUT_WIDTH - totalGap) / Math.max(peers.length, 1);

  return {
    left: LAYOUT_MARGIN_X + index * (width + PARTITION_GAP),
    top: LAYOUT_MARGIN_Y,
    width,
    height: LAYOUT_HEIGHT,
  };
}

function roundPosition(value: number) {
  return Number(value.toFixed(3));
}

function createCameraId(index: number) {
  return `CAM-${String(index + 1).padStart(2, "0")}`;
}
