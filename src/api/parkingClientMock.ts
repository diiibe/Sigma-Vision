import { buildFixtureSnapshot, sampleLotDefinition } from "../data/demoFixtures";
import type {
  CameraVideoSourceState,
  EventHistoryPage,
  LiveStateSnapshot,
  SpatialConfig,
  SpatialConfigBundle,
  SpatialConfigVersionSummary,
  SystemEvent,
} from "../data/types";
import type { ParkingAppClient } from "./parkingClient";

interface MockState {
  snapshot: LiveStateSnapshot;
  bundlesByCamera: Record<string, SpatialConfigBundle>;
  activeCameraId: string;
  eventHistory: SystemEvent[];
}

export function createMockParkingClient(): ParkingAppClient {
  const listeners = new Set<() => void>();
  const state: MockState = {
    snapshot: buildFixtureSnapshot(),
    bundlesByCamera: {
      [sampleLotDefinition.camera.id]: buildInitialBundle(sampleLotDefinition.camera.id),
    },
    activeCameraId: sampleLotDefinition.camera.id,
    eventHistory: [],
  };
  let frameIndex = 0;
  const reservedOverrideIds = new Set<string>();
  state.eventHistory = buildMockEventHistory(state.snapshot);

  const emit = () => {
    listeners.forEach((listener) => listener());
  };

  const updateSnapshot = () => {
    const bundle = state.bundlesByCamera[state.activeCameraId] ?? buildInitialBundle(state.activeCameraId);
    const nextSnapshot = buildFixtureSnapshot({
      frameIndex,
      reservedSlotIds: new Set([
        ...bundle.active.bays.filter((bay) => bay.reservedDefault).map((bay) => bay.id),
        ...reservedOverrideIds,
      ]),
    });
    state.snapshot = {
      ...nextSnapshot,
      config: bundle,
      activeCameraId: state.activeCameraId,
    };
    state.eventHistory = mergeEventHistory(state.snapshot.events, state.eventHistory);
    emit();
  };

  const getBundle = (cameraId: string) => {
    if (!state.bundlesByCamera[cameraId]) {
      state.bundlesByCamera[cameraId] = buildInitialBundle(cameraId);
    }
    return state.bundlesByCamera[cameraId];
  };

  return {
    live: {
      getSnapshot: () => state.snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async refresh(cameraId) {
        if (cameraId) {
          state.activeCameraId = cameraId;
        }
        frameIndex += 1;
        updateSnapshot();
      },
      async listEvents(options = {}) {
        const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
        const start = Number(options.cursor ?? "0") || 0;
        const filtered = options.cameraId
          ? state.eventHistory.filter((event) => event.cameraId === options.cameraId)
          : state.eventHistory;
        const items = filtered.slice(start, start + limit);
        const nextCursor = start + limit < filtered.length ? String(start + limit) : null;
        return {
          items,
          nextCursor,
        } satisfies EventHistoryPage;
      },
      async reserveBay(bayId: string) {
        reservedOverrideIds.add(bayId);
        updateSnapshot();
      },
      async clearBayOverride(bayId: string) {
        reservedOverrideIds.delete(bayId);
        updateSnapshot();
      },
    },
    configs: {
      async getActive(cameraId) {
        state.activeCameraId = cameraId;
        const bundle = getBundle(cameraId);
        updateSnapshot();
        return bundle;
      },
      async getEditorBundle(cameraId, version) {
        state.activeCameraId = cameraId;
        const bundle = getBundle(cameraId);
        const selectedVersion = version ?? bundle.active.version;
        const selected =
          selectedVersion === bundle.active.version
            ? bundle.active
            : {
                ...bundle.active,
                version: selectedVersion,
                status: "draft" as const,
                presetName: `Preset ${selectedVersion}`,
              };
        updateSnapshot();
        return {
          cameraId,
          selectedVersion,
          selected,
          active: bundle.active,
          versions: bundle.versions,
          lotDefinition: sampleLotDefinition,
          videoSource: {
            cameraId,
            sourcePath: null,
            cacheDir: null,
            status: "missing",
            discoveredAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            normalizedFps: 5,
            frameCount: sampleLotDefinition.frames.length,
            currentFrameIndex: frameIndex % Math.max(sampleLotDefinition.frames.length, 1),
            loopCount: 0,
          } satisfies CameraVideoSourceState,
        };
      },
      async getVideoSource(cameraId) {
        return {
          cameraId,
          sourcePath: null,
          cacheDir: null,
          status: "missing",
          discoveredAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          normalizedFps: 5,
          frameCount: sampleLotDefinition.frames.length,
          currentFrameIndex: frameIndex % Math.max(sampleLotDefinition.frames.length, 1),
          loopCount: 0,
        };
      },
      async listVersions(cameraId) {
        return getBundle(cameraId).versions;
      },
      async saveDraft(cameraId, config) {
        state.bundlesByCamera[cameraId] = mergeBundle(getBundle(cameraId), cameraId, config, "draft");
        updateSnapshot();
        return state.bundlesByCamera[cameraId];
      },
      async updatePreset(cameraId, version, config) {
        const bundle = getBundle(cameraId);
        const persisted = {
          ...config,
          cameraId,
          version,
          status: bundle.active.version === version ? bundle.active.status : config.status,
          updatedAt: new Date().toISOString(),
        } satisfies SpatialConfig;
        state.bundlesByCamera[cameraId] = mergeBundle(bundle, cameraId, persisted, persisted.status, version);
        updateSnapshot();
        return persisted;
      },
      async activate(cameraId, version) {
        const bundle = getBundle(cameraId);
        state.bundlesByCamera[cameraId] = mergeBundle(bundle, cameraId, bundle.active, "active", version);
        state.activeCameraId = cameraId;
        updateSnapshot();
        return state.bundlesByCamera[cameraId];
      },
      async clonePreset(cameraId, request) {
        const sourceBundle = getBundle(request.sourceCameraId);
        const sourceConfig = sourceBundle.active;
        const cloned = {
          ...sourceConfig,
          cameraId,
          version: getBundle(cameraId).versions.length + 1,
          status: "draft" as const,
          presetName: request.targetName ?? `Preset ${getBundle(cameraId).versions.length + 1}`,
          copiedFromCameraId: request.sourceCameraId,
          copiedFromVersion: request.sourceVersion,
        };
        state.bundlesByCamera[cameraId] = mergeBundle(getBundle(cameraId), cameraId, cloned, "draft");
        updateSnapshot();
        return cloned;
      },
      async deletePreset(cameraId, version) {
        const bundle = getBundle(cameraId);
        state.bundlesByCamera[cameraId] = {
          active:
            bundle.active.version === version
              ? { ...bundle.active, status: "archived" }
              : bundle.active,
          versions: bundle.versions.filter((entry) => entry.version !== version),
        };
        updateSnapshot();
        return {
          ...bundle.active,
          version,
          status: "archived",
        };
      },
      async saveRun(cameraId, config) {
        const activeBundle = mergeBundle(getBundle(cameraId), cameraId, config, "active", config.version);
        state.bundlesByCamera[cameraId] = activeBundle;
        state.activeCameraId = cameraId;
        updateSnapshot();
        return activeBundle.active;
      },
    },
    counting: {
      async listEvents() { return []; },
      async getSummary() { return { entriesTotal: 0, exitsTotal: 0, entriesLastHour: 0, exitsLastHour: 0 }; },
      async listDensity() { return []; },
      async listAggregates() { return []; },
    },
    observations: {
      async list() { return []; },
      async get() { return null; },
      async create(obs) { return obs; },
      async update(_id, obs) { return obs; },
      async remove() {},
      async toggle() { return null; },
    },
    async listCameraIds() { return [state.activeCameraId]; },
    destroy() {
      listeners.clear();
    },
  };
}

function buildMockEventHistory(snapshot: LiveStateSnapshot): SystemEvent[] {
  const baseEvents = snapshot.events;
  const cameras = snapshot.cameras;
  const olderEvents = Array.from({ length: 60 }, (_, index) => {
    const source = baseEvents[index % Math.max(baseEvents.length, 1)] ?? {
      id: "mock-history-seed",
      type: "sensor_update" as const,
      severity: "info" as const,
      timestamp: snapshot.capturedAt,
      message: "Mock event history seeded",
      cameraId: cameras[0]?.id,
    };
    const camera = cameras[index % Math.max(cameras.length, 1)];
    const timestamp = new Date(Date.parse(source.timestamp) - (index + 1) * 180_000).toISOString();
    return {
      ...source,
      id: `mock-history-${index + 1}`,
      timestamp,
      message: `${source.message} · archive ${index + 1}`,
      cameraId: camera?.id ?? source.cameraId,
    } satisfies SystemEvent;
  });
  return mergeEventHistory(baseEvents, olderEvents);
}

function mergeEventHistory(incoming: SystemEvent[], existing: SystemEvent[]): SystemEvent[] {
  const merged = [...incoming, ...existing];
  const seen = new Set<string>();
  return merged
    .filter((event) => {
      if (seen.has(event.id)) {
        return false;
      }
      seen.add(event.id);
      return true;
    })
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
}

function buildInitialBundle(cameraId = sampleLotDefinition.camera.id): SpatialConfigBundle {
  const point = (x: number, y: number): [number, number] => [x, y];
  const partitions = sampleLotDefinition.levels.flatMap((level, levelIndex) => {
    const levelSlots = sampleLotDefinition.slots.filter((slot) => slot.levelId === level.id);
    const midPoint = Math.max(1, Math.ceil(levelSlots.length / 2));
    return [
      {
        id: `${level.id}-PART-A`,
        name: `${level.name} A`,
        levelId: level.id,
        order: levelIndex * 2,
        gridRows: Math.max(1, ...levelSlots.filter((slot) => slot.column < midPoint).map((slot) => slot.row + 1)),
        gridColumns: Math.max(1, midPoint),
        ownerCameraIds: [cameraId],
        layoutPolygon: null,
      },
      {
        id: `${level.id}-PART-B`,
        name: `${level.name} B`,
        levelId: level.id,
        order: levelIndex * 2 + 1,
        gridRows: Math.max(1, ...levelSlots.filter((slot) => slot.column >= midPoint).map((slot) => slot.row + 1)),
        gridColumns: Math.max(1, levelSlots.length - midPoint),
        ownerCameraIds: [cameraId],
        layoutPolygon: null,
      },
    ].map((partition) => ({
      ...partition,
      gridRows: Math.max(partition.gridRows, 1),
      gridColumns: Math.max(partition.gridColumns, 1),
    }));
  });
  const bays = sampleLotDefinition.slots.map((slot) => ({
    ...slot,
    partitionId: slot.column < 2 ? `${slot.levelId}-PART-A` : `${slot.levelId}-PART-B`,
    cameraId,
    zoneId: slot.zoneId ?? slot.levelId,
  }));
  const active: SpatialConfig = {
    facilityId: sampleLotDefinition.facilityId,
    facilityName: sampleLotDefinition.facilityName,
    timeZone: sampleLotDefinition.timeZone,
    cameraId,
    frameWidth: sampleLotDefinition.frames[0]?.width ?? 1280,
    frameHeight: sampleLotDefinition.frames[0]?.height ?? 720,
    sourceLotKey: sampleLotDefinition.sourceLotKey,
    version: 1,
    status: "active" as const,
    countingEnabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activatedAt: new Date().toISOString(),
    presetName: "Preset 1",
    levels: sampleLotDefinition.levels,
    camera: {
      ...sampleLotDefinition.camera,
      id: cameraId,
    },
    cameras: sampleLotDefinition.cameras.map((camera) =>
      camera.id === sampleLotDefinition.camera.id ? { ...camera, id: cameraId } : camera,
    ),
    frames: sampleLotDefinition.frames.map((frame) => ({
      ...frame,
      cameraId,
    })),
    partitions,
    observationPolygons: sampleLotDefinition.observationPolygons.length > 0
      ? sampleLotDefinition.observationPolygons.map((polygon) => ({
          ...polygon,
          cameraId,
        }))
      : sampleLotDefinition.slots.map((slot) => ({
          id: `obs-${cameraId}-${slot.id}`,
          cameraId,
          presetVersion: 1,
          canonicalBayId: slot.id,
          imagePolygon: slot.imagePolygon,
          enabled: true,
          priority: 1,
          notes: null,
        })),
    bays,
    zones: sampleLotDefinition.levels.map((level, index) => ({
      id: level.id,
      label: level.name,
      levelId: level.id,
      imagePolygon: [
        point(0.1 + index * 0.05, 0.18),
        point(0.8 - index * 0.03, 0.18),
        point(0.8 - index * 0.03, 0.78),
        point(0.1 + index * 0.05, 0.78),
      ],
      layoutPolygon: [
        point(0.1 + index * 0.05, 0.18),
        point(0.8 - index * 0.03, 0.18),
        point(0.8 - index * 0.03, 0.78),
        point(0.1 + index * 0.05, 0.78),
      ],
      bayIds: sampleLotDefinition.slots.filter((slot) => slot.levelId === level.id).map((slot) => slot.id),
    })),
    lines: [
      {
        id: "LINE-ENTRY",
        label: "Entry",
        cameraId,
        kind: "entry" as const,
        enabled: true,
        points: [
          point(0.14, 0.22),
          point(0.86, 0.22),
        ],
        layoutPoints: [
          point(0.14, 0.22),
          point(0.86, 0.22),
        ],
      },
      {
        id: "LINE-EXIT",
        label: "Exit",
        cameraId,
        kind: "exit" as const,
        enabled: true,
        points: [
          point(0.18, 0.78),
          point(0.82, 0.78),
        ],
        layoutPoints: [
          point(0.18, 0.78),
          point(0.82, 0.78),
        ],
      },
    ],
  };

  return {
    active,
    versions: [summarizeConfig(active)],
  };
}

function mergeBundle(
  bundle: SpatialConfigBundle,
  cameraId: string,
  config: SpatialConfig,
  status: SpatialConfig["status"],
  versionOverride?: number,
): SpatialConfigBundle {
  const version = versionOverride ?? config.version;
  const active: SpatialConfig = {
    ...config,
    cameraId,
    version,
    status,
    updatedAt: new Date().toISOString(),
    activatedAt: status === "active" ? new Date().toISOString() : config.activatedAt,
  };
  const versions = [
    ...bundle.versions.filter((entry) => entry.version !== version),
    summarizeConfig(active),
  ].sort((left, right) => left.version - right.version);

  return {
    active,
    versions,
  };
}

function summarizeConfig(config: SpatialConfig): SpatialConfigVersionSummary {
  return {
    cameraId: config.cameraId,
    version: config.version,
    status: config.status,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
    activatedAt: config.activatedAt,
    presetName: config.presetName,
    copiedFromCameraId: config.copiedFromCameraId,
    copiedFromVersion: config.copiedFromVersion,
    bayCount: config.bays.length,
    zoneCount: config.zones.length,
    lineCount: config.lines.length,
  };
}
