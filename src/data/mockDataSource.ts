import type {
  CameraFeed,
  DashboardSnapshot,
  EventSeverity,
  EventType,
  ParkingRuntime,
  ParkingLevel,
  ParkingSlot,
  SpatialConfigBundle,
  SlotStatus,
  SystemEvent,
  VehicleType,
} from "./types";
import { findSlotById, flattenSlots } from "./dashboardUtils";
import { deriveFixtureMetrics } from "./fixtureMetrics";

export { findSlotById, flattenSlots } from "./dashboardUtils";
export { deriveFixtureMetrics } from "./fixtureMetrics";

const LEVEL_COUNT = 5;
const SLOT_ROWS = 2;
const SLOT_COLUMNS = 8;
const SLOT_WIDTH = 1.04;
const SLOT_DEPTH = 0.58;
const MAX_EVENTS = 24;

const PLATES = [
  "AX7-421",
  "KT9-214",
  "ML4-118",
  "HV2-731",
  "PD8-650",
  "CV5-906",
  "ZN1-744",
];

const STATUS_ORDER: SlotStatus[] = ["free", "occupied", "ev", "reserved"];
const VEHICLE_TYPES: VehicleType[] = ["sedan", "suv", "van", "ev"];

interface MutableSlotChange {
  status: SlotStatus;
  message: string;
  severity: EventSeverity;
  type: EventType;
}

export function buildInitialSnapshot(seed = 26): DashboardSnapshot {
  const random = mulberry32(seed);
  const now = Date.now();
  const levels = buildParkingLevels(random, now);
  const cameras = buildCameraFeeds(levels, random, now);
  const events = buildInitialEvents(levels, cameras, random, now);

  return finalizeSnapshot({
    facilityId: "fac-roma-01",
    facilityName: "Piazza Centrale Mobility Hub",
    timeZone: "Europe/Rome",
    capturedAt: new Date(now).toISOString(),
    systemStatus: "online",
    connectionHealth: "stable",
    activeCameraId: cameras[0]?.id ?? null,
    config: buildSpatialConfigBundle(levels, cameras, now),
    levels,
    cameras,
    bayStates: levels.flatMap((level) =>
      level.slots.map((slot) => ({
        bayId: slot.id,
        occupied: slot.status === "occupied" || slot.status === "ev",
        confidence: slot.occupancyProbability,
        lastChangedAt: slot.lastDetectionAt,
        sourceTrackIds: slot.licensePlate ? [slot.id] : [],
      })),
    ),
    zoneKpis: levels.map((level) => ({
      zoneId: level.id,
      totalBays: level.slots.length,
      occupiedBays: level.slots.filter((slot) => slot.status === "occupied" || slot.status === "ev").length,
      availableBays: level.slots.filter((slot) => slot.status === "free").length,
      occupancyPercentage:
        level.slots.length > 0
          ? level.slots.filter((slot) => slot.status === "occupied" || slot.status === "ev").length /
            level.slots.length
          : 0,
      lastUpdatedAt: new Date(now).toISOString(),
    })),
    flowEvents: [],
    alerts: [],
    timeline: [],
    moduleHealth: [
      { module: "ingestion", status: "healthy", latencyMs: 12, message: "Mock ingestion active" },
      { module: "detection", status: "healthy", latencyMs: 18, message: "Mock detection active" },
      { module: "tracking", status: "healthy", latencyMs: 14, message: "Mock tracking active" },
      { module: "state", status: "healthy", latencyMs: 6, message: "Mock state active" },
    ],
    detections: [],
    tracks: [],
    events,
    metrics: deriveFixtureMetrics(levels, events),
  });
}

export function createMockParkingDataSource(
  seed = 26,
  intervalMs = 3600,
): ParkingRuntime {
  const random = mulberry32(seed);
  const listeners = new Set<() => void>();
  let snapshot = buildInitialSnapshot(seed);
  let eventCounter = snapshot.events.length;

  const emit = () => {
    listeners.forEach((listener) => listener());
  };

  const updateSnapshot = (
    recipe: (current: DashboardSnapshot, now: number) => DashboardSnapshot,
  ) => {
    const now = Date.now();
    snapshot = finalizeSnapshot({
      ...recipe(snapshot, now),
      capturedAt: new Date(now).toISOString(),
    });
    emit();
  };

  const interval = globalThis.setInterval(() => {
    updateSnapshot((current, now) =>
      applyRandomActivity(current, random, now, ++eventCounter),
    );
  }, intervalMs);

  return {
    dataSource: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    actions: {
      reserveSlot(slotId) {
        updateSnapshot((current, now) =>
          applySlotChange(
            current,
            slotId,
            {
              status: "reserved",
              message: `Reservation flag applied to ${slotId}`,
              severity: "warning",
              type: "reserved_detected",
            },
            now,
            ++eventCounter,
            random,
          ),
        );
      },
      markAvailable(slotId) {
        updateSnapshot((current, now) =>
          applySlotChange(
            current,
            slotId,
            {
              status: "free",
              message: `Slot ${slotId} returned to available state`,
              severity: "info",
              type: "slot_released",
            },
            now,
            ++eventCounter,
            random,
          ),
        );
      },
      refreshCamera(cameraId) {
        updateSnapshot((current, now) => {
          const cameras = current.cameras.map((camera): CameraFeed =>
            camera.id === cameraId
              ? {
                  ...camera,
                  timestamp: new Date(now).toISOString(),
                  status: "online",
                  streamHealth: 1,
                  thumbnail: createCameraThumbnail(
                    camera.name,
                    formatClockStamp(now),
                    camera.location,
                  ),
                  frameUrl: createCameraThumbnail(
                    camera.name,
                    formatClockStamp(now),
                    camera.location,
                  ),
                }
              : camera,
          );

          const event: SystemEvent = {
            id: `evt-${eventCounter + 1}`,
            type: "sensor_update",
            severity: "info",
            timestamp: new Date(now).toISOString(),
            message: `${cameraId} diagnostics refreshed`,
            cameraId,
          };

          eventCounter += 1;

          return {
            ...current,
            cameras,
            events: [event, ...current.events].slice(0, MAX_EVENTS),
          };
        });
      },
      trackSlot(slotId) {
        updateSnapshot((current, now) => {
          const slot = findSlotById(current.levels, slotId);

          if (!slot) {
            return current;
          }

          const event: SystemEvent = {
            id: `evt-${eventCounter + 1}`,
            type: "sensor_update",
            severity: "info",
            timestamp: new Date(now).toISOString(),
            message: `Tracking enabled for ${slotId}`,
            slotId,
            levelId: slot.levelId,
            cameraId: slot.cameraId,
          };

          eventCounter += 1;

          return {
            ...current,
            events: [event, ...current.events].slice(0, MAX_EVENTS),
          };
        });
      },
    },
    destroy() {
      globalThis.clearInterval(interval);
      listeners.clear();
    },
  };
}

function buildParkingLevels(random: () => number, now: number): ParkingLevel[] {
  const laneSpacing = 2.12;
  const columnSpacing = 1.34;
  const xOffset = -((SLOT_COLUMNS - 1) * columnSpacing) / 2;

  return Array.from({ length: LEVEL_COUNT }, (_, index) => {
    const levelId = `L${String(index + 1).padStart(2, "0")}`;
    const slots: ParkingSlot[] = [];

    for (let row = 0; row < SLOT_ROWS; row += 1) {
      for (let column = 0; column < SLOT_COLUMNS; column += 1) {
        const status = pickSlotStatus(random, index, row, column);
        const slotId = `${levelId}-S${String(row * SLOT_COLUMNS + column + 1).padStart(2, "0")}`;

        slots.push({
          id: slotId,
          label: slotId.replace(`${levelId}-`, ""),
          levelId,
          partitionId: `${levelId}-PART-${column < 4 ? "A" : "B"}`,
          levelIndex: index,
          row,
          column,
          position: [xOffset + column * columnSpacing, row === 0 ? -laneSpacing / 2 : laneSpacing / 2],
          size: [SLOT_WIDTH, SLOT_DEPTH],
          status,
          source: "mock",
          sensorState: random() > 0.92 ? "degraded" : "online",
          cameraId: `CAM-${String(index + 1).padStart(2, "0")}`,
          licensePlate:
            status === "occupied" || status === "ev"
              ? sampleArray(PLATES, random)
              : null,
          vehicleType:
            status === "occupied" || status === "ev"
              ? status === "ev"
                ? "ev"
                : sampleArray(VEHICLE_TYPES.slice(0, 3), random)
              : null,
          confidence: 0.82 + random() * 0.16,
          occupancyProbability: 0.82 + random() * 0.16,
          lastDetectionAt: new Date(now - Math.round(random() * 1000 * 60 * 28)).toISOString(),
          chargingKw: status === "ev" ? 14 + Math.round(random() * 28) : null,
          evCapable: status === "ev",
          imagePolygon: [
            [0.1, 0.1],
            [0.2, 0.1],
            [0.2, 0.2],
            [0.1, 0.2],
          ],
          layoutPolygon: [
            [0.1, 0.1],
            [0.2, 0.1],
            [0.2, 0.2],
            [0.1, 0.2],
          ],
        });
      }
    }

    return {
      id: levelId,
      name: `Deck ${String(index + 1).padStart(2, "0")}`,
      index,
      elevation: index * 1.7,
      dimensions: {
        rows: SLOT_ROWS,
        columns: SLOT_COLUMNS,
        slotWidth: SLOT_WIDTH,
        slotDepth: SLOT_DEPTH,
      },
      slots,
    };
  });
}

function buildCameraFeeds(
  levels: ParkingLevel[],
  random: () => number,
  now: number,
): CameraFeed[] {
  return levels.map((level, index) => {
    const status: CameraFeed["status"] =
      index === 1 ? "latency" : random() > 0.97 ? "offline" : "online";
    const timestamp = new Date(now - index * 1000 * 19).toISOString();
    const thumbnail = createCameraThumbnail(
      `CAM ${String(index + 1).padStart(2, "0")}`,
      formatClockStamp(timestamp),
      level.name,
    );

    return {
      id: `CAM-${String(index + 1).padStart(2, "0")}`,
      name: `Camera ${String(index + 1).padStart(2, "0")}`,
      levelId: level.id,
      location:
        index === levels.length - 1
          ? "Upper ramp approach"
          : `Deck ${String(index + 1).padStart(2, "0")} east corridor`,
      status,
      timestamp,
      thumbnail,
      frameUrl: thumbnail,
      frameId: `mock-frame-${index + 1}`,
      frameLabel: `Mock frame ${index + 1}`,
      imageWidth: 640,
      imageHeight: 360,
      angle: index % 2 === 0 ? "120 deg / overhead" : "84 deg / aisle",
      streamHealth: status === "offline" ? 0.46 : status === "latency" ? 0.72 : 0.96,
    };
  });
}

function buildInitialEvents(
  levels: ParkingLevel[],
  cameras: CameraFeed[],
  random: () => number,
  now: number,
): SystemEvent[] {
  const allSlots = flattenSlots(levels);

  return Array.from({ length: 10 }, (_, index) => {
    const slot = allSlots[Math.floor(random() * allSlots.length)];
    const camera = cameras.find((entry) => entry.id === slot.cameraId) ?? cameras[0];
    const descriptor = slot.status === "free" ? "release verified" : "classification updated";

    return {
      id: `evt-${index + 1}`,
      type:
        slot.status === "reserved"
          ? "reserved_detected"
          : slot.status === "ev"
            ? "ev_charging"
            : slot.status === "occupied"
              ? "slot_occupied"
              : "slot_released",
      severity: slot.status === "reserved" ? "warning" : "info",
      timestamp: new Date(now - index * 1000 * 47).toISOString(),
      message: `${slot.id} ${descriptor} via ${camera.id}`,
      levelId: slot.levelId,
      slotId: slot.id,
      cameraId: camera.id,
    };
  });
}

function applyRandomActivity(
  snapshot: DashboardSnapshot,
  random: () => number,
  now: number,
  eventNumber: number,
) {
  const slot = sampleArray(flattenSlots(snapshot.levels), random);
  const nextStatus = pickNextStatus(slot.status, random);

  const change = buildChangeForStatus(slot.id, nextStatus);

  return applySlotChange(snapshot, slot.id, change, now, eventNumber, random);
}

function applySlotChange(
  snapshot: DashboardSnapshot,
  slotId: string,
  change: MutableSlotChange,
  now: number,
  eventNumber: number,
  random: () => number,
): DashboardSnapshot {
  const slot = findSlotById(snapshot.levels, slotId);

  if (!slot) {
    return snapshot;
  }

  const levels = snapshot.levels.map((level) =>
    level.id === slot.levelId
      ? {
          ...level,
          slots: level.slots.map((entry) =>
            entry.id === slotId
              ? {
                  ...entry,
                  status: change.status,
                  sensorState:
                    entry.sensorState === "offline" ? "online" : entry.sensorState,
                  licensePlate:
                    change.status === "occupied" || change.status === "ev"
                      ? sampleArray(PLATES, random)
                      : null,
                  vehicleType:
                    change.status === "occupied" || change.status === "ev"
                      ? change.status === "ev"
                        ? "ev"
                        : sampleArray(VEHICLE_TYPES.slice(0, 3), random)
                      : null,
                  confidence: 0.84 + random() * 0.12,
                  occupancyProbability: 0.84 + random() * 0.12,
                  chargingKw: change.status === "ev" ? 18 + Math.round(random() * 20) : null,
                  evCapable: change.status === "ev" || entry.evCapable,
                  lastDetectionAt: new Date(now).toISOString(),
                }
              : entry,
          ),
        }
      : level,
  );

  const cameras = snapshot.cameras.map((camera): CameraFeed =>
    camera.id === slot.cameraId
      ? {
          ...camera,
          status: "online",
          timestamp: new Date(now).toISOString(),
          streamHealth: Math.max(camera.streamHealth, 0.88),
          thumbnail: createCameraThumbnail(
            camera.name,
            formatClockStamp(now),
            camera.location,
          ),
          frameUrl: createCameraThumbnail(
            camera.name,
            formatClockStamp(now),
            camera.location,
          ),
        }
      : camera,
  );

  const event: SystemEvent = {
    id: `evt-${eventNumber}`,
    type: change.type,
    severity: change.severity,
    timestamp: new Date(now).toISOString(),
    message: change.message,
    slotId: slot.id,
    levelId: slot.levelId,
    cameraId: slot.cameraId,
  };

  return {
    ...snapshot,
    levels,
    cameras,
    events: [event, ...snapshot.events].slice(0, MAX_EVENTS),
  };
}

function finalizeSnapshot(snapshot: DashboardSnapshot): DashboardSnapshot {
  const metrics = deriveFixtureMetrics(snapshot.levels, snapshot.events);
  const systemStatus = metrics.flaggedEvents > 6 ? "degraded" : "online";
  const connectionHealth = metrics.flaggedEvents > 8 ? "degraded" : "stable";

  return {
    ...snapshot,
    capturedAt: snapshot.capturedAt || new Date().toISOString(),
    systemStatus,
    connectionHealth,
    metrics,
  };
}

function buildSpatialConfigBundle(
  levels: ParkingLevel[],
  cameras: CameraFeed[],
  now: number,
): SpatialConfigBundle {
  const activeCameraId = cameras[0]?.id ?? "CAM-01";
  const activeCameraName = cameras[0]?.name ?? "Camera 01";
  const activeLevelId = levels[0]?.id ?? "LEVEL-01";
  const partitions = levels.flatMap((level, index) => {
    const gridColumns = Math.max(1, ...level.slots.map((slot) => slot.column + 1));
    const midPoint = Math.max(1, Math.ceil(gridColumns / 2));
    const primaryCameraId = cameras[index]?.id ?? activeCameraId;
    const secondaryCameraId = cameras[(index + 1) % Math.max(cameras.length, 1)]?.id ?? primaryCameraId;

    return [
      {
        id: `${level.id}-PART-A`,
        name: `${level.name} A`,
        levelId: level.id,
        order: index * 2,
        gridRows: Math.max(1, ...level.slots.filter((slot) => slot.column < midPoint).map((slot) => slot.row + 1)),
        gridColumns: midPoint,
        ownerCameraIds: [primaryCameraId],
        layoutPolygon: null,
      },
      {
        id: `${level.id}-PART-B`,
        name: `${level.name} B`,
        levelId: level.id,
        order: index * 2 + 1,
        gridRows: Math.max(1, ...level.slots.filter((slot) => slot.column >= midPoint).map((slot) => slot.row + 1)),
        gridColumns: Math.max(1, gridColumns - midPoint),
        ownerCameraIds: [secondaryCameraId],
        layoutPolygon: null,
      },
    ];
  });
  return {
    active: {
      facilityId: "piazza-centrale",
      facilityName: "Piazza Centrale Mobility Hub",
      timeZone: "Europe/Rome",
      cameraId: activeCameraId,
      frameWidth: 1280,
      frameHeight: 720,
      sourceLotKey: "mock://facility/piazza-centrale",
      version: 1,
      status: "active" as const,
      countingEnabled: true,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      activatedAt: new Date(now).toISOString(),
      presetName: "Preset 1",
      levels: levels.map((level) => ({
        id: level.id,
        name: level.name,
        index: level.index,
        gridRows: Math.max(1, ...level.slots.map((slot) => slot.row + 1)),
        gridColumns: Math.max(1, ...level.slots.map((slot) => slot.column + 1)),
      })),
      camera: {
        id: activeCameraId,
        name: activeCameraName,
        levelId: activeLevelId,
        location: cameras[0]?.location ?? "North access",
        angle: cameras[0]?.angle ?? "34° overhead",
      },
      cameras: cameras.map((camera) => ({
        id: camera.id,
        name: camera.name,
        levelId: camera.levelId,
        location: camera.location,
        angle: camera.angle,
      })),
      frames: cameras.map((camera) => ({
        id: camera.frameId,
        cameraId: camera.id,
        label: camera.frameLabel,
        imagePath: camera.frameUrl,
        capturedAt: camera.timestamp,
        width: camera.imageWidth,
        height: camera.imageHeight,
      })),
      bays: flattenSlots(levels).map((slot) => ({
        id: slot.id,
        label: slot.label,
        levelId: slot.levelId,
        cameraId: slot.cameraId,
        row: slot.row,
        column: slot.column,
        zoneId: slot.levelId,
        imagePolygon: slot.imagePolygon,
        layoutPolygon: slot.layoutPolygon,
        evCapable: slot.evCapable,
        reservedDefault: slot.status === "reserved",
        partitionId: slot.column < 4 ? `${slot.levelId}-PART-A` : `${slot.levelId}-PART-B`,
      })),
      partitions,
      zones: levels.map((level, index) => ({
        id: level.id,
        label: level.name,
        levelId: level.id,
        imagePolygon: [
          [0.12 + index * 0.05, 0.2],
          [0.8 - index * 0.02, 0.2],
          [0.8 - index * 0.02, 0.78],
          [0.12 + index * 0.05, 0.78],
        ],
        layoutPolygon: [
          [0.12 + index * 0.05, 0.2],
          [0.8 - index * 0.02, 0.2],
          [0.8 - index * 0.02, 0.78],
          [0.12 + index * 0.05, 0.78],
        ],
        bayIds: level.slots.map((slot) => slot.id),
      })),
      observationPolygons: flattenSlots(levels).map((slot) => ({
        id: `obs-${activeCameraId}-${slot.id}`,
        cameraId: activeCameraId,
        presetVersion: 1,
        canonicalBayId: slot.id,
        imagePolygon: slot.imagePolygon,
        enabled: true,
        priority: 1,
        notes: null,
      })),
      lines: [
        {
          id: "LINE-ENTRY",
          label: "Entry",
          cameraId: activeCameraId,
          kind: "entry" as const,
          enabled: true,
          points: [
            [0.12, 0.24],
            [0.86, 0.24],
          ],
          layoutPoints: [
            [0.12, 0.24],
            [0.86, 0.24],
          ],
          direction: "entry",
        },
        {
          id: "LINE-EXIT",
          label: "Exit",
          cameraId: activeCameraId,
          kind: "exit" as const,
          enabled: true,
          points: [
            [0.18, 0.78],
            [0.82, 0.78],
          ],
          layoutPoints: [
            [0.18, 0.78],
            [0.82, 0.78],
          ],
          direction: "exit",
        },
      ],
    },
    versions: [
      {
        cameraId: activeCameraId,
        version: 1,
        status: "active" as const,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        bayCount: flattenSlots(levels).length,
        zoneCount: levels.length,
        lineCount: 2,
      },
    ],
  };
}

function pickSlotStatus(
  random: () => number,
  levelIndex: number,
  row: number,
  column: number,
): SlotStatus {
  if ((column === 0 || column === SLOT_COLUMNS - 1) && levelIndex % 2 === 0) {
    return "reserved";
  }

  if (row === 0 && column % 3 === 0) {
    return "ev";
  }

  const roll = random();

  if (roll < 0.4) {
    return "free";
  }

  if (roll < 0.76) {
    return "occupied";
  }

  if (roll < 0.88) {
    return "ev";
  }

  return "reserved";
}

function pickNextStatus(current: SlotStatus, random: () => number): SlotStatus {
  const pool = STATUS_ORDER.filter((status) => status !== current);
  return sampleArray(pool, random);
}

function buildChangeForStatus(slotId: string, status: SlotStatus): MutableSlotChange {
  switch (status) {
    case "free":
      return {
        status,
        message: `${slotId} released and confirmed clear`,
        severity: "info",
        type: "slot_released",
      };
    case "occupied":
      return {
        status,
        message: `${slotId} vehicle occupancy confirmed`,
        severity: "warning",
        type: "slot_occupied",
      };
    case "ev":
      return {
        status,
        message: `${slotId} charging session detected`,
        severity: "info",
        type: "ev_charging",
      };
    case "reserved":
      return {
        status,
        message: `${slotId} reserved bay restriction active`,
        severity: "warning",
        type: "reserved_detected",
      };
    case "unknown":
      return {
        status,
        message: `${slotId} sensor state unavailable`,
        severity: "info",
        type: "sensor_update",
      };
  }
}

function sampleArray<T>(values: T[], random: () => number): T {
  return values[Math.floor(random() * values.length)];
}

function formatClockStamp(input: number | string) {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(typeof input === "number" ? input : new Date(input));
}

function createCameraThumbnail(
  label: string,
  time: string,
  location: string,
): string {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="400" height="240" viewBox="0 0 400 240">
      <defs>
        <linearGradient id="a" x1="0%" x2="100%" y1="0%" y2="100%">
          <stop offset="0%" stop-color="#11161e" />
          <stop offset="100%" stop-color="#1e2732" />
        </linearGradient>
      </defs>
      <rect width="400" height="240" fill="url(#a)" />
      <g stroke="#314052" stroke-width="1" opacity="0.35">
        <path d="M0 50 H400M0 120 H400M0 190 H400" />
        <path d="M60 0 V240M170 0 V240M280 0 V240" />
      </g>
      <g stroke="#7e98b4" stroke-width="1.5" opacity="0.8">
        <path d="M52 84 L145 84 L182 120 L323 120" fill="none" />
        <path d="M92 159 L172 159 L205 122 L348 122" fill="none" />
      </g>
      <rect x="18" y="18" width="112" height="28" rx="4" fill="#0f1319" stroke="#425268" stroke-width="1" />
      <text x="32" y="36" fill="#c8d3de" font-size="14" font-family="IBM Plex Mono, monospace">${label}</text>
      <text x="18" y="216" fill="#8ca0b7" font-size="12" font-family="IBM Plex Mono, monospace">${time}</text>
      <text x="18" y="198" fill="#9fafbf" font-size="13" font-family="IBM Plex Sans, Arial, sans-serif">${location}</text>
      <circle cx="360" cy="28" r="6" fill="#bf5d49" />
      <rect x="332" y="18" width="50" height="20" rx="3" fill="#0e1218" stroke="#435266" />
    </svg>
  `;

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function mulberry32(seed: number) {
  let state = seed;

  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let output = Math.imul(state ^ (state >>> 15), 1 | state);
    output = (output + Math.imul(output ^ (output >>> 7), 61 | output)) ^ output;
    return ((output ^ (output >>> 14)) >>> 0) / 4294967296;
  };
}
