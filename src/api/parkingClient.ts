import { createMockParkingClient } from "./parkingClientMock";
import type {
  CameraPresetCloneRequest,
  CameraVideoSourceState,
  CountingAggregatePoint,
  CountingEvent,
  DensitySnapshot,
  EventHistoryPage,
  EditorCameraBundle,
  LiveStateSnapshot,
  ObservationDefinition,
  SpatialConfig,
  SpatialConfigBundle,
  SpatialConfigVersionSummary,
} from "../data/types";

export interface CountingSummary {
  entriesTotal: number;
  exitsTotal: number;
  entriesLastHour: number;
  exitsLastHour: number;
}

export interface ParkingAppClient {
  live: {
    getSnapshot(): LiveStateSnapshot | null;
    subscribe(listener: () => void): () => void;
    refresh(cameraId?: string): Promise<void>;
    listEvents(options?: {
      cameraId?: string;
      cursor?: string | null;
      limit?: number;
    }): Promise<EventHistoryPage>;
    reserveBay?(bayId: string): Promise<void>;
    clearBayOverride?(bayId: string): Promise<void>;
  };
  configs: {
    getActive(cameraId: string): Promise<SpatialConfigBundle>;
    getEditorBundle(cameraId: string, version?: number): Promise<EditorCameraBundle>;
    getVideoSource(cameraId: string): Promise<CameraVideoSourceState | null>;
    listVersions(cameraId: string): Promise<SpatialConfigVersionSummary[]>;
    saveDraft(cameraId: string, config: SpatialConfig): Promise<SpatialConfigBundle>;
    updatePreset(cameraId: string, version: number, config: SpatialConfig): Promise<SpatialConfig>;
    activate(cameraId: string, version: number): Promise<SpatialConfigBundle>;
    clonePreset(cameraId: string, request: CameraPresetCloneRequest): Promise<SpatialConfig>;
    deletePreset(cameraId: string, version: number): Promise<SpatialConfig>;
    saveRun(cameraId: string, config: SpatialConfig): Promise<SpatialConfig>;
  };
  counting: {
    listEvents(options?: {
      cameraId?: string;
      lineId?: string;
      since?: string;
      limit?: number;
    }): Promise<CountingEvent[]>;
    getSummary(options?: {
      associationType?: string;
      associationId?: string;
      since?: string;
    }): Promise<CountingSummary>;
    listDensity(options?: {
      zoneId?: string;
      since?: string;
      limit?: number;
    }): Promise<DensitySnapshot[]>;
    listAggregates(options?: {
      granularity?: string;
      since?: string;
      until?: string;
      associationType?: string;
      associationId?: string;
    }): Promise<CountingAggregatePoint[]>;
  };
  observations: {
    list(cameraId?: string): Promise<ObservationDefinition[]>;
    get(id: string): Promise<ObservationDefinition | null>;
    create(obs: ObservationDefinition): Promise<ObservationDefinition>;
    update(id: string, obs: ObservationDefinition): Promise<ObservationDefinition>;
    remove(id: string): Promise<void>;
    toggle(id: string, enabled: boolean): Promise<ObservationDefinition | null>;
  };
  listCameraIds(): Promise<string[]>;
  destroy(): void;
}

interface BrowserClientOptions {
  apiBase?: string;
  pollMs?: number;
}

const DEFAULT_API_BASE = "/api";
const DEFAULT_POLL_MS = 5_000;

export function createBrowserParkingClient(
  options: BrowserClientOptions = {},
): ParkingAppClient {
  const apiBase = options.apiBase ?? DEFAULT_API_BASE;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const fallback = createMockParkingClient();
  const listeners = new Set<() => void>();
  let snapshot: LiveStateSnapshot | null = fallback.live.getSnapshot();
  let disposed = false;
  let activeStream: EventSource | null = null;
  let pollTimer: number | null = null;
  let preferredLiveCameraId: string | null = null;

  const emit = () => {
    listeners.forEach((listener) => listener());
  };

  const setSnapshot = (next: LiveStateSnapshot | null) => {
    snapshot = next;
    emit();
  };

  const stopPolling = () => {
    if (pollTimer === null) {
      return;
    }

    window.clearInterval(pollTimer);
    pollTimer = null;
  };

  const stopStream = () => {
    activeStream?.close();
    activeStream = null;
  };

  const tryLoadLiveSnapshot = async (cameraId = preferredLiveCameraId) => {
    const query = cameraId ? `?cameraId=${encodeURIComponent(cameraId)}` : "";
    const livePaths = cameraId
      ? [`${apiBase}/live/snapshot${query}`]
      : [`${apiBase}/live/snapshot${query}`, `${apiBase}/demo/snapshot`];
    const nextSnapshot = await tryLoadJson<LiveStateSnapshot>(livePaths);

    if (nextSnapshot) {
      setSnapshot(nextSnapshot);
      return true;
    }

    return false;
  };

  const startPolling = () => {
    if (pollTimer !== null) {
      return;
    }

    pollTimer = window.setInterval(() => {
      void tryLoadLiveSnapshot();
    }, pollMs);
  };

  const startStream = (cameraId = preferredLiveCameraId) => {
    stopStream();

    if (typeof EventSource !== "function") {
      startPolling();
      return;
    }

    const query = cameraId ? `?cameraId=${encodeURIComponent(cameraId)}` : "";
    const stream = new EventSource(`${apiBase}/live/stream${query}`);
    let hasOpened = false;
    activeStream = stream;

    const applyStreamPayload = (rawData: string) => {
      try {
        const nextSnapshot = JSON.parse(rawData) as LiveStateSnapshot;
        setSnapshot(nextSnapshot);
      } catch {
        // Ignore malformed stream payloads and let polling recover if needed.
      }
    };

    stream.onopen = () => {
      hasOpened = true;
      stopPolling();
    };

    stream.onmessage = (event) => {
      hasOpened = true;
      stopPolling();
      applyStreamPayload(event.data);
    };

    stream.addEventListener("snapshot", (event) => {
      hasOpened = true;
      stopPolling();
      applyStreamPayload((event as MessageEvent<string>).data);
    });

    stream.onerror = () => {
      if (disposed || activeStream !== stream) {
        return;
      }

      if (!hasOpened || stream.readyState === EventSource.CLOSED) {
        stopStream();
        startPolling();
      }
    };
  };

  const getJson = async <T,>(paths: string[], init?: RequestInit): Promise<T | null> => {
    for (const path of paths) {
      try {
        const response = await fetch(path, init);
        if (!response.ok) {
          continue;
        }

        return (await response.json()) as T;
      } catch {
        continue;
      }
    }

    return null;
  };

  const postJson = async <T,>(paths: string[], body?: unknown): Promise<T | null> => {
    for (const path of paths) {
      try {
        const hasBody = body !== undefined;
        const response = await fetch(path, {
          method: "POST",
          headers: hasBody
            ? {
                "Content-Type": "application/json",
              }
            : undefined,
          body: hasBody ? JSON.stringify(body) : undefined,
        });
        if (!response.ok) {
          continue;
        }

        return (await response.json()) as T;
      } catch {
        continue;
      }
    }

    return null;
  };

  const loadConfigBundle = async (cameraId: string) => {
    const response = await getJson<SpatialConfigBundle>([
      `${apiBase}/spatial-configs/${cameraId}/active`,
      `${apiBase}/spatial-configs/active`,
    ]);

    return response ?? fallback.configs.getActive(cameraId);
  };

  const loadEditorBundle = async (cameraId: string, version?: number) => {
    const query = version !== undefined ? `?version=${version}` : "";
    const response = await getJson<EditorCameraBundle>([
      `${apiBase}/editor/cameras/${cameraId}/bundle${query}`,
    ]);

    if (response) {
      return response;
    }

    return fallback.configs.getEditorBundle(cameraId, version);
  };

  const performBayMutation = async (
    paths: string[],
    bayId: string,
    fallbackAction?: (bayId: string) => Promise<void> | void,
  ) => {
    const response = await postJson<{ snapshot?: LiveStateSnapshot } | LiveStateSnapshot>(paths);

    if (response) {
      await tryLoadLiveSnapshot();
      return;
    }

    if (fallbackAction) {
      await fallbackAction(bayId);
      setSnapshot(fallback.live.getSnapshot());
    }
  };

  void tryLoadLiveSnapshot().then((loaded) => {
    if (disposed || loaded) {
      if (loaded) {
        startStream();
      }
      return;
    }

    startStream();
  });

  return {
    live: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async refresh(cameraId) {
        if (cameraId !== undefined) {
          const changedCamera = preferredLiveCameraId !== cameraId;
          preferredLiveCameraId = cameraId;
          if (changedCamera) {
            startStream(cameraId);
          }
        }
        if (!(await tryLoadLiveSnapshot(cameraId))) {
          await fallback.live.refresh(cameraId);
          setSnapshot(fallback.live.getSnapshot());
        }
      },
      async listEvents(options = {}) {
        const params = new URLSearchParams();
        if (options.cameraId) {
          params.set("cameraId", options.cameraId);
        }
        if (options.cursor) {
          params.set("cursor", options.cursor);
        }
        if (options.limit !== undefined) {
          params.set("limit", String(options.limit));
        }
        const suffix = params.size > 0 ? `?${params.toString()}` : "";
        const response = await getJson<EventHistoryPage>([
          `${apiBase}/live/events${suffix}`,
        ]);

        if (response) {
          return response;
        }

        return fallback.live.listEvents(options);
      },
      async reserveBay(bayId: string) {
        await performBayMutation(
          [
            `${apiBase}/live/bays/${bayId}/reserve`,
          ],
          bayId,
          fallback.live.reserveBay,
        );
      },
      async clearBayOverride(bayId: string) {
        await performBayMutation(
          [
            `${apiBase}/live/bays/${bayId}/clear-override`,
          ],
          bayId,
          fallback.live.clearBayOverride,
        );
      },
    },
    configs: {
      async getActive(cameraId) {
        return loadConfigBundle(cameraId);
      },
      async getEditorBundle(cameraId, version) {
        return loadEditorBundle(cameraId, version);
      },
      async getVideoSource(cameraId) {
        const response = await getJson<CameraVideoSourceState>([
          `${apiBase}/editor/cameras/${cameraId}/video-source`,
        ]);

        if (response) {
          return response;
        }

        return fallback.configs.getVideoSource(cameraId);
      },
      async listVersions(cameraId) {
        const response = await getJson<SpatialConfigVersionSummary[]>([
          `${apiBase}/spatial-configs/${cameraId}/versions`,
          `${apiBase}/spatial-configs/versions`,
        ]);

        if (response) {
          return response;
        }

        return fallback.configs.listVersions(cameraId);
      },
      async saveDraft(cameraId, config) {
        const response = await postJson<SpatialConfigBundle>(
          [
            `${apiBase}/spatial-configs/${cameraId}/versions`,
            `${apiBase}/spatial-configs/versions`,
          ],
          config,
        );

        if (response) {
          return response;
        }

        return fallback.configs.saveDraft(cameraId, config);
      },
      async updatePreset(cameraId, version, config) {
        try {
          const response = await fetch(`${apiBase}/editor/cameras/${cameraId}/presets/${version}`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(config),
          });
          if (response.ok) {
            return (await response.json()) as SpatialConfig;
          }
        } catch {
          // Fall back below.
        }

        return fallback.configs.updatePreset(cameraId, version, config);
      },
      async activate(cameraId, version) {
        const response = await postJson<SpatialConfigBundle>(
          [
            `${apiBase}/spatial-configs/${cameraId}/activate`,
            `${apiBase}/spatial-configs/activate`,
          ],
          { version },
        );

        if (response) {
          return response;
        }

        return fallback.configs.activate(cameraId, version);
      },
      async clonePreset(cameraId, request) {
        const response = await postJson<SpatialConfig>(
          [`${apiBase}/editor/cameras/${cameraId}/presets/clone`],
          request,
        );

        if (response) {
          return response;
        }

        return fallback.configs.clonePreset(cameraId, request);
      },
      async deletePreset(cameraId, version) {
        try {
          const response = await fetch(`${apiBase}/editor/cameras/${cameraId}/presets/${version}`, {
            method: "DELETE",
          });
          if (response.ok) {
            return (await response.json()) as SpatialConfig;
          }
        } catch {
          // Fall back below.
        }

        return fallback.configs.deletePreset(cameraId, version);
      },
      async saveRun(cameraId, config) {
        const response = await postJson<SpatialConfig>(
          [`${apiBase}/editor/cameras/${cameraId}/save-run`],
          config,
        );

        if (response) {
          return response;
        }

        return fallback.configs.saveRun(cameraId, config);
      },
    },
    counting: {
      async listEvents(options = {}) {
        const params = new URLSearchParams();
        if (options.cameraId) params.set("cameraId", options.cameraId);
        if (options.lineId) params.set("lineId", options.lineId);
        if (options.since) params.set("since", options.since);
        if (options.limit !== undefined) params.set("limit", String(options.limit));
        const suffix = params.size > 0 ? `?${params.toString()}` : "";
        return (await getJson<CountingEvent[]>([`${apiBase}/counting/events${suffix}`])) ?? [];
      },
      async getSummary(options = {}) {
        const params = new URLSearchParams();
        if (options.associationType) params.set("associationType", options.associationType);
        if (options.associationId) params.set("associationId", options.associationId);
        if (options.since) params.set("since", options.since);
        const suffix = params.size > 0 ? `?${params.toString()}` : "";
        return (
          (await getJson<CountingSummary>([`${apiBase}/counting/summary${suffix}`])) ?? {
            entriesTotal: 0,
            exitsTotal: 0,
            entriesLastHour: 0,
            exitsLastHour: 0,
          }
        );
      },
      async listDensity(options = {}) {
        const params = new URLSearchParams();
        if (options.zoneId) params.set("zoneId", options.zoneId);
        if (options.since) params.set("since", options.since);
        if (options.limit !== undefined) params.set("limit", String(options.limit));
        const suffix = params.size > 0 ? `?${params.toString()}` : "";
        return (await getJson<DensitySnapshot[]>([`${apiBase}/counting/density${suffix}`])) ?? [];
      },
      async listAggregates(options = {}) {
        const params = new URLSearchParams();
        if (options.granularity) params.set("granularity", options.granularity);
        if (options.since) params.set("since", options.since);
        if (options.until) params.set("until", options.until);
        if (options.associationType) params.set("associationType", options.associationType);
        if (options.associationId) params.set("associationId", options.associationId);
        const suffix = params.size > 0 ? `?${params.toString()}` : "";
        return (
          (await getJson<CountingAggregatePoint[]>([`${apiBase}/counting/aggregates${suffix}`])) ??
          []
        );
      },
    },
    observations: {
      async list(cameraId?: string) {
        const suffix = cameraId ? `?cameraId=${encodeURIComponent(cameraId)}` : "";
        return (
          (await getJson<ObservationDefinition[]>([`${apiBase}/observations${suffix}`])) ?? []
        );
      },
      async get(id: string) {
        return (await getJson<ObservationDefinition>([`${apiBase}/observations/${encodeURIComponent(id)}`])) ?? null;
      },
      async create(obs: ObservationDefinition) {
        const res = await fetch(`${apiBase}/observations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(obs),
        });
        if (!res.ok) throw new Error(`Failed to create observation: ${res.status}`);
        return res.json();
      },
      async update(id: string, obs: ObservationDefinition) {
        const res = await fetch(`${apiBase}/observations/${encodeURIComponent(id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(obs),
        });
        if (!res.ok) throw new Error(`Failed to update observation: ${res.status}`);
        return res.json();
      },
      async remove(id: string) {
        const res = await fetch(`${apiBase}/observations/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        if (!res.ok && res.status !== 204) throw new Error(`Failed to delete observation: ${res.status}`);
      },
      async toggle(id: string, enabled: boolean) {
        const res = await fetch(
          `${apiBase}/observations/${encodeURIComponent(id)}/toggle?enabled=${enabled}`,
          { method: "POST" },
        );
        if (!res.ok) throw new Error(`Failed to toggle observation: ${res.status}`);
        return res.json();
      },
    },
    async listCameraIds() {
      return (await getJson<string[]>([`${apiBase}/cameras/ids`])) ?? [];
    },
    destroy() {
      disposed = true;
      stopStream();
      stopPolling();
      listeners.clear();
      fallback.destroy();
    },
  };
}

async function tryLoadJson<T>(paths: string[]) {
  for (const path of paths) {
    try {
      const response = await fetch(path);
      if (!response.ok) {
        continue;
      }

      return (await response.json()) as T;
    } catch {
      continue;
    }
  }

  return null;
}
