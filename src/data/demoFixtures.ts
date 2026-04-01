import { deriveFixtureMetrics } from "./fixtureMetrics";
import {
  createRectanglePolygon,
} from "./polygon";
import {
  getLotPartitions,
  createCameraDefinition,
  createFrameDefinition,
  createLevelDefinition,
  deriveMatrixSlotPosition,
  deriveMatrixSlotSize,
  getLotCameras,
  getLotLevels,
  syncLotDefinition,
} from "./lotMatrix";
import type {
  DashboardSnapshot,
  LotDefinition,
  LotFrameDefinition,
  OccupancyPrediction,
  ParkingSlot,
  LotSlotDefinition,
  Polygon,
  SystemEvent,
  VehicleType,
  SpatialConfigBundle,
  SpatialConfig,
  BayState,
  ZoneKpiState,
  FlowEvent,
  AlertEvent,
  TimelinePoint,
  ModuleHealth,
} from "./types";

const SAMPLE_FRAME_COUNT = 6;
const CAMERA_ID = "CAM-ACPDS-01";
const SAMPLE_LEVELS = [
  createLevelDefinition(0),
  createLevelDefinition(1),
  createLevelDefinition(2),
];

export const sampleLotDefinition = createSampleLotDefinition();

export function buildFixturePredictions(
  lotDefinition: LotDefinition,
  frameIndex: number,
): OccupancyPrediction[] {
  const cameras = getLotCameras(lotDefinition);

  return cameras.flatMap((camera, cameraIndex) => {
    const cameraFrames = lotDefinition.frames.filter((frame) => frame.cameraId === camera.id);
    const frame = cameraFrames[frameIndex % Math.max(cameraFrames.length, 1)] ?? lotDefinition.frames[0];
    const cameraSlots = lotDefinition.slots.filter(
      (slot) => slot.ownerCameraIds?.includes(camera.id) || slot.cameraId === camera.id,
    );

    return cameraSlots.map((slot, slotIndex) => {
      const seed = hashString(`${slot.id}:${frame.id}`);
      const occupied = ((seed + frameIndex * 11 + (cameraIndex + slotIndex) * 7) % 100) > 47;
      const confidence = clampProbability(
        occupied ? 0.66 + (seed % 26) / 100 : 0.58 + (seed % 20) / 100,
      );

      return {
        slotId: slot.id,
        occupied,
        confidence,
        observedAt: frame.capturedAt,
        frameId: frame.id,
      };
    });
  });
}

export function buildFixtureSnapshot(options?: {
  lotDefinition?: LotDefinition;
  frameIndex?: number;
  events?: SystemEvent[];
  reservedSlotIds?: Set<string>;
}): DashboardSnapshot {
  const lotDefinition = syncLotDefinition(options?.lotDefinition ?? sampleLotDefinition);
  const frameIndex = options?.frameIndex ?? 0;
  const cameras = getLotCameras(lotDefinition);
  const selectedFrameByCameraId = new Map(
    cameras.map((camera) => {
      const cameraFrames = lotDefinition.frames.filter((frame) => frame.cameraId === camera.id);
      return [camera.id, cameraFrames[frameIndex % Math.max(cameraFrames.length, 1)] ?? lotDefinition.frames[0]] as const;
    }),
  );
  const primaryFrame = selectedFrameByCameraId.get(cameras[0]?.id ?? "") ?? lotDefinition.frames[0];
  const predictions = buildFixturePredictions(lotDefinition, frameIndex);
  const predictionBySlotId = new Map(predictions.map((entry) => [entry.slotId, entry]));
  const reservedSlotIds = options?.reservedSlotIds ?? new Set<string>();
  const levels = getLotLevels(lotDefinition).map((level) => {
    const levelSlots = lotDefinition.slots.filter((slot) => slot.levelId === level.id);
    const rows = Math.max(level.gridRows ?? 1, 1);
    const columns = Math.max(level.gridColumns ?? 1, 1);
    const slots: ParkingSlot[] = levelSlots.map((slot) =>
      buildSnapshotSlot(slot, {
        frameCapturedAt:
          selectedFrameByCameraId.get(slot.cameraId)?.capturedAt ?? primaryFrame.capturedAt,
        levelIndex: level.index,
        rows,
        columns,
        prediction: predictionBySlotId.get(slot.id),
        reservedSlotIds,
      }),
    );

    return {
      id: level.id,
      name: level.name,
      index: level.index,
      elevation: level.index * 1.76,
      dimensions: {
        rows,
        columns,
        slotWidth: 1.04,
        slotDepth: 0.58,
      },
      slots,
    };
  });

  const allSlots = levels.flatMap((level) => level.slots);
  const events = options?.events ?? buildInitialEvents(allSlots, primaryFrame.capturedAt);
  const configBundle = buildSpatialConfigBundle(lotDefinition, primaryFrame);

  const snapshot: DashboardSnapshot = {
    facilityId: lotDefinition.facilityId,
    facilityName: lotDefinition.facilityName,
    timeZone: lotDefinition.timeZone,
    capturedAt: primaryFrame.capturedAt,
    systemStatus: "online",
    connectionHealth: "stable",
    activeCameraId: cameras[0]?.id ?? null,
    config: configBundle,
    levels,
    cameras: cameras.map((camera) => {
      const frame = selectedFrameByCameraId.get(camera.id) ?? primaryFrame;
      const polygons = lotDefinition.slots
        .filter((slot) => slot.ownerCameraIds?.includes(camera.id) || slot.cameraId === camera.id)
        .map((slot) => slot.imagePolygon);
      const frameUrl = buildPlaceholderFrame(frame.id, polygons);

      return {
        id: camera.id,
        name: camera.name,
        levelId: camera.levelId,
        location: camera.location,
        status: "online" as const,
        timestamp: frame.capturedAt,
        thumbnail: frameUrl,
        frameUrl,
        frameId: frame.id,
        frameLabel: frame.label,
        imageWidth: frame.width,
        imageHeight: frame.height,
        angle: camera.angle,
        streamHealth: 0.98,
      };
    }),
    bayStates: buildBayStates(levels),
    zoneKpis: buildZoneKpis(levels),
    flowEvents: buildFlowEvents(events),
    alerts: buildAlerts(levels, events),
    timeline: buildTimeline(levels, events, primaryFrame.capturedAt),
    moduleHealth: buildModuleHealth(),
    detections: [],
    tracks: [],
    events,
    metrics: { totalSlots: 0, occupiedSlots: 0, freeSlots: 0, evSlots: 0, reservedSlots: 0, unknownSlots: 0, occupancyRate: 0, onlineSensors: 0, flaggedEvents: 0, levelStats: [] },
  };

  return {
    ...snapshot,
    metrics: deriveFixtureMetrics(levels, events),
  };
}

function createSampleLotDefinition(): LotDefinition {
  const primaryCamera = {
    id: CAMERA_ID,
    name: "ACPDS Overlook 01",
    levelId: SAMPLE_LEVELS[0].id,
    location: "Elevated east perimeter",
    angle: "47deg oblique",
  };

  return syncLotDefinition({
    facilityId: "acpds-demo",
    facilityName: "ACPDS Lot 07",
    timeZone: "Europe/Rome",
    levelId: SAMPLE_LEVELS[0].id,
    levelName: SAMPLE_LEVELS[0].name,
    levels: SAMPLE_LEVELS,
    sourceLotKey: "fallback-reference-lot",
    camera: primaryCamera,
    cameras: [primaryCamera],
    frames: Array.from({ length: SAMPLE_FRAME_COUNT }, (_, index) =>
      createFrameDefinition(CAMERA_ID, index, {
        id: `frame-${String(index + 1).padStart(2, "0")}`,
        label: `Capture ${index + 1}`,
      }),
    ),
    partitions: SAMPLE_LEVELS.flatMap((level, index) => [
      {
        id: `${level.id}-PART-A`,
        name: `${level.name} A`,
        levelId: level.id,
        order: index * 2,
        gridRows: 1,
        gridColumns: 2,
        ownerCameraIds: [CAMERA_ID],
        layoutPolygon: null,
      },
      {
        id: `${level.id}-PART-B`,
        name: `${level.name} B`,
        levelId: level.id,
        order: index * 2 + 1,
        gridRows: 1,
        gridColumns: 2,
        ownerCameraIds: [CAMERA_ID],
        layoutPolygon: null,
      },
    ]),
    observationPolygons: [],
    slots: buildSampleSlots(),
  });
}

function buildSampleSlots() {
  const slots: LotSlotDefinition[] = [];

  for (let planeIndex = 0; planeIndex < SAMPLE_LEVELS.length; planeIndex += 1) {
    const levelId = SAMPLE_LEVELS[planeIndex].id;
    for (let column = 0; column < 4; column += 1) {
      const slotIndex = planeIndex * 4 + column;
      const imagePolygon = createImagePolygon(column, planeIndex);
      const slot: LotSlotDefinition = {
        id: `B${String(slotIndex + 1).padStart(2, "0")}`,
        label: `Bay ${String(slotIndex + 1).padStart(2, "0")}`,
        row: 0,
        column,
        levelId,
        partitionId: `${levelId}-PART-${column < 2 ? "A" : "B"}`,
        cameraId: CAMERA_ID,
        imagePolygon,
        layoutPolygon: createRectanglePolygon(0.5, 0.5, 0.12, 0.16),
        evCapable: slotIndex === 2 || slotIndex === 7 || slotIndex === 10,
        zoneId: levelId,
        ownerCameraIds: [CAMERA_ID],
        reservedDefault: slotIndex === 4,
      };

      slots.push(slot);
    }
  }

  return slots;
}

function createImagePolygon(column: number, row: number): Polygon {
  const topY = 0.18 + row * 0.16;
  const bottomY = topY + 0.18;
  const centerX = 0.2 + column * 0.16 + row * 0.025;
  const topWidth = 0.085 - row * 0.01;
  const bottomWidth = 0.12 - row * 0.006;

  return [
    [centerX - topWidth / 2, topY],
    [centerX + topWidth / 2, topY],
    [centerX + bottomWidth / 2, bottomY],
    [centerX - bottomWidth / 2, bottomY],
  ];
}

function buildInitialEvents(slots: ParkingSlot[], timestamp: string): SystemEvent[] {
  return slots
    .slice(0, 4)
    .map((slot, index) => ({
      id: `evt-seed-${index + 1}`,
      type:
        slot.status === "free"
          ? ("sensor_update" as "sensor_update")
          : ("slot_occupied" as "slot_occupied"),
      severity: index === 0 ? ("warning" as "warning") : ("info" as "info"),
      timestamp,
      message:
        slot.status === "free"
          ? `${slot.id} awaiting next inference pass`
          : `${slot.id} confirmed ${slot.status} from curated model frame`,
      slotId: slot.id,
      levelId: slot.levelId,
      cameraId: slot.cameraId,
    }))
    .reverse();
}

function buildSpatialConfigBundle(
  lotDefinition: LotDefinition,
  primaryFrame: LotFrameDefinition,
): SpatialConfigBundle {
  const active = buildSpatialConfig(lotDefinition, primaryFrame, "active");

  return {
    active,
    versions: [
      {
        cameraId: active.cameraId,
        version: active.version,
        status: active.status,
        createdAt: active.createdAt,
        updatedAt: active.updatedAt,
        bayCount: active.bays.length,
        zoneCount: active.zones.length,
        lineCount: active.lines.length,
      },
    ],
  };
}

function buildSpatialConfig(
  lotDefinition: LotDefinition,
  primaryFrame: LotFrameDefinition,
  status: SpatialConfig["status"],
): SpatialConfig {
  const selectedCamera =
    getLotCameras(lotDefinition).find((camera) => camera.id === primaryFrame.cameraId) ??
    lotDefinition.camera;
  const point = (x: number, y: number): [number, number] => [x, y];
  const bays: SpatialConfig["bays"] = lotDefinition.slots.map((slot) => ({
      id: slot.id,
      label: slot.label,
      levelId: slot.levelId,
      partitionId: slot.partitionId,
      cameraId: slot.cameraId,
      row: slot.row,
      column: slot.column,
      zoneId: slot.levelId,
      imagePolygon: slot.imagePolygon,
    layoutPolygon: slot.layoutPolygon,
    evCapable: slot.evCapable,
    reservedDefault: slot.reservedDefault,
  }));
  const zones: SpatialConfig["zones"] = getLotLevels(lotDefinition).map((level, index) => ({
    id: `ZONE-${String(index + 1).padStart(2, "0")}`,
    label: level.name,
    levelId: level.id,
    imagePolygon: createRectanglePolygon(0.5, 0.5, 0.7 - index * 0.08, 0.24),
    layoutPolygon: createRectanglePolygon(0.5, 0.5, 0.7 - index * 0.08, 0.24),
    bayIds: bays.filter((bay) => bay.zoneId === level.id).map((bay) => bay.id),
  }));
  const lines: SpatialConfig["lines"] = [
    {
      id: "LINE-ENTRY",
      label: "Entry",
      cameraId: selectedCamera.id,
      kind: "entry" as const,
      enabled: true,
      points: [
        point(0.14, 0.18),
        point(0.86, 0.18),
      ],
      layoutPoints: [
        point(0.14, 0.18),
        point(0.86, 0.18),
      ],
      direction: "entry",
    },
    {
      id: "LINE-EXIT",
      label: "Exit",
      cameraId: selectedCamera.id,
      kind: "exit" as const,
      enabled: true,
      points: [
        point(0.18, 0.82),
        point(0.82, 0.82),
      ],
      layoutPoints: [
        point(0.18, 0.82),
        point(0.82, 0.82),
      ],
      direction: "exit",
    },
  ];

  return {
    facilityId: lotDefinition.facilityId,
    facilityName: lotDefinition.facilityName,
    timeZone: lotDefinition.timeZone,
    cameraId: selectedCamera.id,
    frameWidth: primaryFrame.width,
    frameHeight: primaryFrame.height,
    sourceLotKey: lotDefinition.sourceLotKey,
    version: 1,
    status,
    createdAt: primaryFrame.capturedAt,
    updatedAt: primaryFrame.capturedAt,
    activatedAt: primaryFrame.capturedAt,
    presetName: selectedCamera.name,
    levels: lotDefinition.levels,
    camera: selectedCamera,
    cameras: lotDefinition.cameras,
    frames: lotDefinition.frames,
    partitions: lotDefinition.partitions.length > 0 ? lotDefinition.partitions : getLotPartitions(lotDefinition),
    observationPolygons:
      lotDefinition.observationPolygons.length > 0
        ? lotDefinition.observationPolygons
        : lotDefinition.slots.map((slot) => ({
            id: `obs-${selectedCamera.id}-${slot.id}`,
            cameraId: selectedCamera.id,
            presetVersion: 1,
            canonicalBayId: slot.id,
            imagePolygon: slot.imagePolygon,
            enabled: true,
            priority: 1,
            notes: null,
          })),
    bays,
    zones,
    lines,
    countingEnabled: true,
  };
}

function buildBayStates(levels: DashboardSnapshot["levels"]): BayState[] {
  return levels.flatMap((level) =>
    level.slots.map((slot) => ({
      bayId: slot.id,
      occupied: slot.status === "occupied" || slot.status === "ev",
      confidence: slot.confidence,
      lastChangedAt: slot.lastDetectionAt,
      sourceTrackIds: slot.licensePlate ? [slot.id] : [],
    })),
  );
}

function buildZoneKpis(levels: DashboardSnapshot["levels"]): ZoneKpiState[] {
  return levels.map((level) => {
    const occupied = level.slots.filter((slot) => slot.status === "occupied" || slot.status === "ev").length;
    const total = level.slots.length;

    return {
      zoneId: level.id,
      totalBays: total,
      occupiedBays: occupied,
      availableBays: Math.max(0, total - occupied),
      occupancyPercentage: total > 0 ? occupied / total : 0,
      lastUpdatedAt: level.slots[0]?.lastDetectionAt ?? new Date().toISOString(),
    };
  });
}

function buildFlowEvents(events: SystemEvent[]): FlowEvent[] {
  return events
    .filter((event) => Boolean(event.slotId))
    .slice(0, 6)
    .map((event, index) => ({
      lineId: index % 2 === 0 ? "LINE-ENTRY" : "LINE-EXIT",
      eventType: index % 2 === 0 ? "entry" : "exit",
      trackId: event.slotId ?? `track-${index + 1}`,
      timestamp: event.timestamp,
      direction: index % 2 === 0 ? "inbound" : "outbound",
      confidence: 0.74,
      valid: event.severity !== "critical",
    }));
}

function buildAlerts(levels: DashboardSnapshot["levels"], events: SystemEvent[]): AlertEvent[] {
  const occupancyRate = levels.length > 0
    ? levels.flatMap((level) => level.slots).filter((slot) => slot.status === "occupied" || slot.status === "ev").length /
      levels.flatMap((level) => level.slots).length
    : 0;

  return [
    {
      alertId: "ALERT-01",
      sourceKpi: "occupancy",
      thresholdRule: "occupancy > 0.75",
      severity: occupancyRate > 0.75 ? "warning" : "info",
      active: occupancyRate > 0.75,
      firstSeen: events[0]?.timestamp ?? new Date().toISOString(),
      lastEvaluated: events[0]?.timestamp ?? new Date().toISOString(),
      explanation: occupancyRate > 0.75 ? "Occupancy exceeded the warning threshold." : "Occupancy is within range.",
    },
  ];
}

function buildTimeline(
  levels: DashboardSnapshot["levels"],
  events: SystemEvent[],
  capturedAt: string,
): TimelinePoint[] {
  const occupied = levels.flatMap((level) => level.slots).filter((slot) => slot.status === "occupied" || slot.status === "ev").length;
  const total = levels.flatMap((level) => level.slots).length;
  const available = Math.max(0, total - occupied);

  return Array.from({ length: 6 }, (_, index) => ({
    bucketStart: new Date(Date.parse(capturedAt) - (5 - index) * 60_000).toISOString(),
    occupancyPercentage: total > 0 ? occupied / total : 0,
    occupiedBays: occupied,
    availableBays: available,
    entries: Math.max(0, events.length - index),
    exits: Math.max(0, index - 1),
    alerts: index === 5 ? events.filter((event) => event.severity !== "info").length : 0,
  }));
}

function buildModuleHealth(): ModuleHealth[] {
  return [
    { module: "ingestion", status: "healthy", latencyMs: 12, message: "Frames replaying normally" },
    { module: "detection", status: "healthy", latencyMs: 18, message: "Detections simulated" },
    { module: "tracking", status: "healthy", latencyMs: 14, message: "Tracks stable" },
    { module: "state", status: "healthy", latencyMs: 6, message: "State snapshot current" },
  ];
}

function buildSnapshotSlot(
  slot: LotSlotDefinition,
  options: {
    frameCapturedAt: string;
    levelIndex: number;
    rows: number;
    columns: number;
    prediction: OccupancyPrediction | undefined;
    reservedSlotIds: Set<string>;
  },
): ParkingSlot {
  const occupied = options.prediction?.occupied ?? false;
  const isEv = occupied && slot.evCapable && hashString(`${slot.id}:ev`) % 3 === 0;
  const isReserved =
    !occupied && (options.reservedSlotIds.has(slot.id) || slot.reservedDefault === true);
  const status = isEv
    ? "ev"
    : occupied
      ? "occupied"
      : isReserved
        ? "reserved"
        : "free";
  const probability = options.prediction?.confidence ?? 0.5;

  return {
    id: slot.id,
    label: slot.label,
    levelId: slot.levelId,
    partitionId: slot.partitionId,
    levelIndex: options.levelIndex,
    row: slot.row,
    column: slot.column,
    position: deriveMatrixSlotPosition(slot.row, slot.column, options.rows, options.columns),
    size: deriveMatrixSlotSize(),
    status,
    source: "model",
    sensorState: hashString(`${slot.id}:sensor`) % 11 === 0 ? "degraded" : "online",
    cameraId: slot.cameraId,
    licensePlate: occupied ? seededPlate(slot.id) : null,
    vehicleType: occupied ? (isEv ? "ev" : seededVehicleType(slot.id)) : null,
    confidence: probability,
    occupancyProbability: probability,
    lastDetectionAt: options.prediction?.observedAt ?? options.frameCapturedAt,
    chargingKw: isEv ? 14 + (hashString(`${slot.id}:kw`) % 12) * 2 : null,
    evCapable: slot.evCapable,
    imagePolygon: slot.imagePolygon,
    layoutPolygon: slot.layoutPolygon,
  };
}

function buildPlaceholderFrame(frameId: string, polygons: Polygon[]) {
  const slotPaths = polygons
    .map((polygon) =>
      polygon
        .map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x * 1280} ${y * 720}`)
        .join(" ")
        .concat(" Z"),
    )
    .map(
      (path) =>
        `<path d="${path}" fill="rgba(255,255,255,0.02)" stroke="rgba(214,225,255,0.14)" stroke-width="2" />`,
    )
    .join("");

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#3e464f" />
          <stop offset="100%" stop-color="#1a1f26" />
        </linearGradient>
      </defs>
      <rect width="1280" height="720" fill="url(#bg)" />
      <g opacity="0.28">
        <path d="M0 140 L1280 90" stroke="#d9dde4" stroke-width="6" stroke-dasharray="18 16" />
        <path d="M0 255 L1280 210" stroke="#d9dde4" stroke-width="6" stroke-dasharray="18 16" />
        <path d="M0 390 L1280 340" stroke="#d9dde4" stroke-width="6" stroke-dasharray="18 16" />
        <path d="M0 550 L1280 500" stroke="#d9dde4" stroke-width="8" stroke-dasharray="26 22" />
      </g>
      <g opacity="0.85">${slotPaths}</g>
      <text x="68" y="74" fill="#edf2fb" font-size="34" font-family="IBM Plex Sans, sans-serif">${frameId}</text>
      <text x="68" y="112" fill="#bcc7d8" font-size="20" font-family="IBM Plex Mono, monospace">ACPDS placeholder frame</text>
    </svg>
  `.trim();

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function seededPlate(slotId: string) {
  const alphabet = "ABCDEFGHJKLMNPRSTUVWXYZ";
  const hash = hashString(slotId);
  return `${alphabet[hash % alphabet.length]}${alphabet[(hash >> 2) % alphabet.length]}-${100 + (hash % 900)}-${10 + ((hash >> 4) % 90)}`;
}

function seededVehicleType(slotId: string): VehicleType {
  const types: VehicleType[] = ["sedan", "suv", "van"];
  return types[hashString(`${slotId}:vehicle`) % types.length];
}

function hashString(value: string) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash;
}

function clampProbability(value: number) {
  return Math.max(0.5, Math.min(0.99, Number(value.toFixed(2))));
}
