import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParkingClientProvider } from "../api/parkingClientContext";
import type { ParkingAppClient } from "../api/parkingClient";
import { buildInitialSnapshot } from "../data/mockDataSource";
import type {
  EventHistoryPage,
  EditorCameraBundle,
  LiveStateSnapshot,
  SpatialConfig,
  SpatialConfigBundle,
  SpatialConfigVersionSummary,
  SlotStatus,
  SystemEvent,
} from "../data/types";
import { flattenSlots } from "../data/dashboardUtils";
import { resetDashboardStore } from "../store/dashboardStore";
import { reconcileActiveLevelIds, TacticalDashboard } from "./TacticalDashboard";

interface HistoryRequest {
  cameraId?: string;
  cursor?: string | null;
  limit?: number;
}

interface DashboardTestClient extends ParkingAppClient {
  historyRequests: HistoryRequest[];
}

vi.mock("../scene/ParkingScene", () => ({
  ParkingScene: () => <div data-testid="parking-scene" />,
}));

vi.mock("../hooks/useReducedMotion", () => ({
  useReducedMotion: () => false,
}));

vi.mock("./SceneViewport", async () => {
  const React = await import("react");

  return {
    SceneViewport: ({
      selectedSlot,
      trackedSlotId,
      activeOverlays,
      onReserveSlot,
      onMarkAvailable,
      onTrackSlot,
      onToggleOverlay,
      onCloseDetailCard,
    }: {
      selectedSlot: { label: string; id: string } | null;
      trackedSlotId: string | null;
      activeOverlays: { occupancyDwell: boolean; vehicleTurnover: boolean };
      onReserveSlot(): void;
      onMarkAvailable(): void;
      onTrackSlot(): void;
      onToggleOverlay(key: "occupancyDwell" | "vehicleTurnover"): void;
      onCloseDetailCard(): void;
    }) => {
      const [isOverlayPanelOpen, setIsOverlayPanelOpen] = React.useState(false);

      return (
        <section className="scene-panel">
          <div className="scene-panel__chrome">
            <div>
              <h2>3D lot matrix</h2>
            </div>
          </div>

          {isOverlayPanelOpen ? (
            <div aria-label="Bay overlay controls">
              <button
                type="button"
                aria-pressed={activeOverlays.occupancyDwell}
                onClick={() => onToggleOverlay("occupancyDwell")}
              >
                Occupancy dwell · 24h
              </button>
              <button
                type="button"
                aria-pressed={activeOverlays.vehicleTurnover}
                onClick={() => onToggleOverlay("vehicleTurnover")}
              >
                Vehicle turnover
              </button>
              <button
                type="button"
                aria-label="Collapse overlay controls"
                onClick={() => setIsOverlayPanelOpen(false)}
              >
                ×
              </button>
            </div>
          ) : (
            <button
              type="button"
              aria-expanded="false"
              onClick={() => setIsOverlayPanelOpen(true)}
            >
              Overlay
            </button>
          )}

          {selectedSlot ? (
            <div className="detail-card">
              <h3>{selectedSlot.label}</h3>
              <p className="detail-card__slot-code">{selectedSlot.id}</p>
              <button type="button" onClick={onReserveSlot}>
                Flag reserved
              </button>
              <button type="button" onClick={onTrackSlot}>
                {trackedSlotId === selectedSlot.id ? "Tracking active" : "Track bay"}
              </button>
              <button type="button" onClick={onMarkAvailable}>
                Clear override
              </button>
              <button type="button" onClick={onCloseDetailCard}>
                Close
              </button>
            </div>
          ) : null}
        </section>
      );
    },
  };
});

describe("TacticalDashboard", () => {
  afterEach(() => {
    act(() => {
      resetDashboardStore();
    });
    vi.useRealTimers();
  });

  it("renders live state from the parking client", async () => {
    const client = createDashboardTestClient();
    const snapshot = client.live.getSnapshot();

    if (!snapshot) {
      throw new Error("Expected a live snapshot for the dashboard test client.");
    }

    await renderDashboard(client);

    expect(await screen.findByText("Piazza Centrale Mobility Hub")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Occupancy summary" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Filters" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Selected feed" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Event log" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Camera 01 live frame" })).toBeInTheDocument();
    expect(screen.getByLabelText("Relevant partitions")).toBeInTheDocument();
    expect(screen.getByText(/Deck 01 A/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Overlay" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Track bay" })).not.toBeInTheDocument();

    client.destroy();
  });

  it("switches the monitoring feed from the client-backed camera list", async () => {
    const client = createDashboardTestClient();

    await renderDashboard(client);

    expect(await screen.findByRole("img", { name: "Camera 01 live frame" })).toBeInTheDocument();
    const initialFrameImage = document.querySelector(".camera-focus__frame img");
    expect(initialFrameImage?.getAttribute("src")).toContain("cameraId=CAM-01");
    expect(screen.queryByRole("button", { name: "Track bay" })).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Change camera" }));
    });
    await flushDashboardUpdates();

    expect(screen.getByRole("img", { name: "Camera 02 live frame" })).toBeInTheDocument();
    const nextFrameImage = document.querySelector(".camera-focus__frame img");
    expect(nextFrameImage?.getAttribute("src")).toContain("cameraId=CAM-02");
    expect(client.live.getSnapshot()?.config?.active.cameraId).toBe("CAM-02");
    expect(screen.queryByRole("button", { name: "Track bay" })).not.toBeInTheDocument();
    client.destroy();
  });

  it("updates the selected slot through the backend-backed reserve and clear actions", async () => {
    const client = createDashboardTestClient();

    await renderDashboard(client);
    await selectSlotFromEventLog(client);

    const flagButton = await screen.findByRole("button", { name: "Flag reserved" });
    const selectedSlotCode = screen.getByText(/^[A-Z0-9-]+$/, {
      selector: ".detail-card__slot-code",
    }).textContent;

    expect(flagButton).toBeEnabled();

    await act(async () => {
      fireEvent.click(flagButton);
    });
    await flushDashboardUpdates();

    expect(
      client
        .live
        .getSnapshot()
        ?.levels.flatMap((level) => level.slots)
        .find((slot) => slot.id === selectedSlotCode)?.status,
    ).toBe("reserved");

    await act(async () => {
      await client.live.clearBayOverride?.(selectedSlotCode ?? "");
    });

    expect(
      client
        .live
        .getSnapshot()
        ?.levels.flatMap((level) => level.slots)
        .find((slot) => slot.id === selectedSlotCode)?.status,
    ).toBe("free");
    client.destroy();
  });

  it("tracks the selected bay through the UI store without leaving the historic layout", async () => {
    const client = createDashboardTestClient();

    await renderDashboard(client);
    await selectSlotFromEventLog(client);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Track bay" }));
    });
    await flushDashboardUpdates();

    expect(screen.getByRole("button", { name: "Tracking active" })).toBeInTheDocument();
    client.destroy();
  });

  it("opens the config route through the supplied callback", async () => {
    const client = createDashboardTestClient();
    const onOpenEditor = vi.fn();

    await renderDashboard(client, onOpenEditor);

    const header = await screen.findByRole("banner", { name: "System header" });

    await act(async () => {
      fireEvent.click(within(header).getByRole("button", { name: "Edit lot" }));
    });
    await flushDashboardUpdates();

    expect(onOpenEditor).toHaveBeenCalledTimes(1);
    client.destroy();
  });

  it("supports concurrent overlays and collapsed overlay controls", async () => {
    const client = createDashboardTestClient();

    await renderDashboard(client);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Overlay" }));
    });
    await flushDashboardUpdates();

    const occupancyToggle = await screen.findByRole("button", {
      name: /Occupancy dwell/i,
    });
    const turnoverToggle = screen.getByRole("button", {
      name: /Vehicle turnover/i,
    });

    await act(async () => {
      fireEvent.click(occupancyToggle);
      fireEvent.click(turnoverToggle);
    });
    await flushDashboardUpdates();

    expect(occupancyToggle).toHaveAttribute("aria-pressed", "true");
    expect(turnoverToggle).toHaveAttribute("aria-pressed", "true");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Collapse overlay controls" }));
    });
    await flushDashboardUpdates();

    expect(screen.getByRole("button", { name: "Overlay" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Occupancy dwell/i })).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Overlay" }));
    });
    await flushDashboardUpdates();

    expect(screen.getByRole("button", { name: /Occupancy dwell/i })).toBeInTheDocument();
    client.destroy();
  });

  it("opens the event archive from the preview and switches between feed and global history", async () => {
    const client = createDashboardTestClient();

    await renderDashboard(client);
    await openEventHistoryFromPreview();

    const dialog = await screen.findByRole("dialog", { name: "Event history" });
    expect(within(dialog).getByRole("button", { name: /This feed/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(client.historyRequests[0]).toMatchObject({
      cameraId: "CAM-01",
      limit: 50,
    });

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /All feeds/i }));
    });
    await flushDashboardUpdates();

    await waitFor(() => {
      expect(client.historyRequests.some((request) => request.cameraId === undefined)).toBe(true);
    });

    const otherFeedEvent = within(dialog).getByRole("button", {
      name: /Archive follow-up 2\b/i,
    });

    await act(async () => {
      fireEvent.click(otherFeedEvent);
    });
    await flushDashboardUpdates();

    expect(screen.queryByRole("dialog", { name: "Event history" })).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Camera 02 live frame" })).toBeInTheDocument();
    client.destroy();
  });

  it("loads older archived events as the operator scrolls down the history dialog", async () => {
    const client = createDashboardTestClient();

    await renderDashboard(client);
    await openEventHistoryFromPreview();

    const dialog = await screen.findByRole("dialog", { name: "Event history" });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /All feeds/i }));
    });
    await flushDashboardUpdates();
    const scrollContainer = dialog.querySelector(".event-history-dialog__scroll");

    if (!(scrollContainer instanceof HTMLDivElement)) {
      throw new Error("Expected the event history dialog to expose a scroll container.");
    }

    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 1_200,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 300,
    });
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 860,
      writable: true,
    });

    await act(async () => {
      scrollContainer.scrollTop = 860;
      fireEvent.scroll(scrollContainer);
    });
    await flushDashboardUpdates();

    await waitFor(() => {
      expect(client.historyRequests.some((request) => request.cursor === "50")).toBe(true);
    });

    expect(within(dialog).getByRole("button", { name: /Archive follow-up 58\b/i })).toBeInTheDocument();
    client.destroy();
  });

  it("updates bay state counts to match the active zones filter", async () => {
    const client = createDashboardTestClient();
    const snapshot = client.live.getSnapshot();

    if (!snapshot) {
      throw new Error("Expected a live snapshot for the dashboard test client.");
    }

    await renderDashboard(client);

    const excludedLevel = snapshot.levels[0];
    const expectedCounts = countSlotsByStatus(
      flattenSlots(snapshot.levels.filter((level) => level.id !== excludedLevel.id)),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: excludedLevel.name }));
    });
    await flushDashboardUpdates();

    expect(getBayStateCount("Free")).toBe(expectedCounts.free);
    expect(getBayStateCount("Occupied")).toBe(expectedCounts.occupied);
    expect(getBayStateCount("EV")).toBe(expectedCounts.ev);
    expect(getBayStateCount("Reserved")).toBe(expectedCounts.reserved);
    expect(getBayStateCount("Unknown")).toBe(expectedCounts.unknown);

    client.destroy();
  });

  it("renders separate plane and zone filters, and zone filters use plane.zone labels", async () => {
    const client = createDashboardTestClient();
    const snapshot = client.live.getSnapshot();

    if (!snapshot) {
      throw new Error("Expected a live snapshot for the dashboard test client.");
    }

    await renderDashboard(client);

    expect(screen.getByText("Planes")).toBeInTheDocument();
    expect(screen.getByText("Zones")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zone 1.1" })).toBeInTheDocument();

    const expectedCounts = countSlotsByStatus(
      flattenSlots(snapshot.levels).filter((slot) => slot.partitionId !== `${snapshot.levels[0]?.id}-PART-A`),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Zone 1.1" }));
    });
    await flushDashboardUpdates();

    expect(getBayStateCount("Free")).toBe(expectedCounts.free);
    expect(getBayStateCount("Occupied")).toBe(expectedCounts.occupied);
    expect(getBayStateCount("EV")).toBe(expectedCounts.ev);
    expect(getBayStateCount("Reserved")).toBe(expectedCounts.reserved);
    expect(getBayStateCount("Unknown")).toBe(expectedCounts.unknown);

    client.destroy();
  });

  it("adds newly available zones to the active scene layers", () => {
    expect(reconcileActiveLevelIds(["ZONE-A"], ["ZONE-A", "ZONE-B"], ["ZONE-A"])).toEqual([
      "ZONE-A",
      "ZONE-B",
    ]);
    expect(reconcileActiveLevelIds(["ZONE-A", "STALE"], ["ZONE-A", "ZONE-B"], ["ZONE-A"])).toEqual([
      "ZONE-A",
      "ZONE-B",
    ]);
    expect(reconcileActiveLevelIds(["ZONE-B"], ["ZONE-A", "ZONE-B"], ["ZONE-A", "ZONE-B"])).toBeNull();
    expect(reconcileActiveLevelIds([], ["ZONE-A", "ZONE-B"])).toBeNull();
  });
});

async function renderDashboard(client: ParkingAppClient, onOpenEditor = vi.fn()) {
  await act(async () => {
    render(
      <ParkingClientProvider client={client}>
        <TacticalDashboard onOpenEditor={onOpenEditor} />
      </ParkingClientProvider>,
    );
  });
  await flushDashboardUpdates();
}

async function flushDashboardUpdates() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function selectSlotFromEventLog(client: ParkingAppClient) {
  const event = client.live.getSnapshot()?.events.find((entry) => entry.slotId);
  const slotId = event?.slotId;

  if (!slotId) {
    throw new Error("Expected at least one event log entry linked to a slot.");
  }

  await openEventHistoryFromPreview();
  const dialog = await screen.findByRole("dialog", { name: "Event history" });

  await act(async () => {
    const [matchingEvent] = within(dialog).getAllByRole("button", {
      name: new RegExp(slotId, "i"),
    });
    fireEvent.click(matchingEvent);
  });
  await flushDashboardUpdates();
}

async function openEventHistoryFromPreview() {
  const eventLog = screen.getByRole("list", { name: "System event log" });
  const [firstPreviewEvent] = within(eventLog).getAllByRole("button");

  await act(async () => {
    fireEvent.click(firstPreviewEvent);
  });
  await flushDashboardUpdates();
}

function getBayStateCount(label: string) {
  const filterGroup = screen.getByRole("group", { name: "Filter parking slots" });
  const button = within(filterGroup).getByRole("button", {
    name: new RegExp(label, "i"),
  });
  const match = button.textContent?.match(/(\d+)\s*$/);

  if (!match) {
    throw new Error(`Expected a numeric count at the end of the ${label} filter chip.`);
  }

  return Number(match[1]);
}

function countSlotsByStatus(slots: Array<{ status: SlotStatus }>) {
  return slots.reduce<Record<SlotStatus, number>>(
    (counts, slot) => {
      counts[slot.status] += 1;
      return counts;
    },
    {
      free: 0,
      occupied: 0,
      ev: 0,
      reserved: 0,
      unknown: 0,
    },
  );
}

function createDashboardTestClient(): DashboardTestClient {
  let snapshot: LiveStateSnapshot = buildInitialSnapshot();
  let eventHistory = buildTestEventHistory(snapshot);
  let refreshCount = 0;
  const listeners = new Set<() => void>();
  const historyRequests: HistoryRequest[] = [];
  const requireConfig = () => {
    if (!snapshot.config) {
      throw new Error("Expected the test snapshot to include an active config bundle.");
    }

    return snapshot.config;
  };

  const emit = () => {
    act(() => {
      listeners.forEach((listener) => listener());
    });
  };

  const syncConfigBundle = (config: SpatialConfig): SpatialConfigBundle => {
    const configBundle = requireConfig();
    snapshot = {
      ...snapshot,
      config: {
        active: config,
        versions: upsertVersion(configBundle.versions, summarizeConfig(config)),
      },
    };
    emit();
    return snapshot.config ?? {
      active: config,
      versions: upsertVersion(configBundle.versions, summarizeConfig(config)),
    };
  };

  const syncConfig = (config: SpatialConfig): SpatialConfig => {
    return syncConfigBundle(config).active;
  };

  const updateSlotStatus = (slotId: string, status: SlotStatus) => {
    const nextLevels = snapshot.levels.map((level) => ({
      ...level,
      slots: level.slots.map((slot) =>
        slot.id === slotId
          ? {
              ...slot,
              status,
            }
          : slot,
      ),
    }));
    const nextSlots = nextLevels.flatMap((level) => level.slots);
    snapshot = {
      ...snapshot,
      levels: nextLevels,
      metrics: {
        ...snapshot.metrics,
        occupiedSlots: nextSlots.filter((slot) => slot.status === "occupied" || slot.status === "ev").length,
        freeSlots: nextSlots.filter((slot) => slot.status === "free").length,
        reservedSlots: nextSlots.filter((slot) => slot.status === "reserved").length,
        unknownSlots: nextSlots.filter((slot) => slot.status === "unknown").length,
      },
    };
    eventHistory = eventHistory.map((event) =>
      event.slotId === slotId
        ? {
            ...event,
            message: `${slotId} ${status === "reserved" ? "reserved manually" : "returned to available state"}`,
          }
        : event,
    );
    emit();
  };

  const syncPreviewEvents = (cameraId: string) => {
    snapshot = {
      ...snapshot,
      activeCameraId: cameraId,
      events: eventHistory.filter((event) => event.cameraId === cameraId).slice(0, 24),
    };
  };

  syncPreviewEvents(snapshot.activeCameraId ?? snapshot.cameras[0]?.id ?? "CAM-01");

  return {
    historyRequests,
    live: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async refresh(cameraId) {
        if (!cameraId || cameraId === snapshot.config?.active.cameraId) {
          return;
        }
        refreshCount += 1;
        if (snapshot.config) {
          snapshot = {
            ...snapshot,
            config: {
              ...snapshot.config,
              active: {
                ...snapshot.config.active,
                cameraId,
                camera: {
                  ...snapshot.config.active.camera,
                  id: cameraId,
                  name:
                    snapshot.cameras.find((camera) => camera.id === cameraId)?.name ??
                    snapshot.config.active.camera.name,
                },
              },
            },
          };
        }
        snapshot = {
          ...snapshot,
          capturedAt: new Date(Date.parse(snapshot.capturedAt) + 1_000).toISOString(),
          cameras: snapshot.cameras.map((camera, index) =>
            camera.id === cameraId
              ? {
                  ...camera,
                  frameLabel: `Refresh ${refreshCount}`,
                  timestamp: new Date(Date.parse(camera.timestamp) + 1_000).toISOString(),
                }
              : camera,
          ),
        };
        syncPreviewEvents(cameraId);
        emit();
      },
      async listEvents(options = {}) {
        historyRequests.push(options);
        const limit = Math.max(1, options.limit ?? 50);
        const start = Number(options.cursor ?? "0") || 0;
        const filtered = options.cameraId
          ? eventHistory.filter((event) => event.cameraId === options.cameraId)
          : eventHistory;
        const items = filtered.slice(start, start + limit);
        const nextCursor = start + limit < filtered.length ? String(start + limit) : null;
        return {
          items,
          nextCursor,
        } satisfies EventHistoryPage;
      },
      async reserveBay(bayId: string) {
        updateSlotStatus(bayId, "reserved");
      },
      async clearBayOverride(bayId: string) {
        updateSlotStatus(bayId, "free");
      },
    },
    configs: {
      async getActive() {
        return requireConfig();
      },
      async getEditorBundle(cameraId, version) {
        const configBundle = requireConfig();
        const selected = {
          ...configBundle.active,
          cameraId,
          version: version ?? configBundle.active.version,
          status: version && version !== configBundle.active.version ? "draft" : configBundle.active.status,
        } satisfies SpatialConfig;

        return {
          cameraId,
          selectedVersion: selected.version,
          selected,
          active: configBundle.active,
          versions: configBundle.versions,
          lotDefinition: {
            facilityId: selected.facilityId,
            facilityName: selected.facilityName,
            timeZone: selected.timeZone,
            levelId: selected.levels[0]?.id ?? "PLANE-01",
            levelName: selected.levels[0]?.name ?? "Plane 01",
            levels: selected.levels,
            sourceLotKey: selected.sourceLotKey,
            camera: selected.camera,
            cameras: selected.cameras,
            frames: selected.frames,
            slots: selected.bays.map((bay) => ({
              id: bay.id,
              label: bay.label,
              row: bay.row,
              column: bay.column,
              levelId: bay.levelId,
              partitionId: bay.partitionId,
              cameraId: bay.cameraId ?? cameraId,
              imagePolygon: bay.imagePolygon,
              layoutPolygon: bay.layoutPolygon,
              evCapable: bay.evCapable,
              zoneId: bay.zoneId ?? bay.levelId,
              reservedDefault: bay.reservedDefault,
            })),
            partitions: selected.partitions,
            observationPolygons: selected.observationPolygons,
          },
          videoSource: null,
        } satisfies EditorCameraBundle;
      },
      async getVideoSource() {
        return null;
      },
      async listVersions() {
        return requireConfig().versions;
      },
      async saveDraft(_cameraId, config) {
        return syncConfigBundle({
          ...config,
          status: "draft",
          updatedAt: new Date().toISOString(),
        });
      },
      async updatePreset(_cameraId, _version, config) {
        return syncConfig({
          ...config,
          updatedAt: new Date().toISOString(),
        });
      },
      async clonePreset(cameraId, request) {
        const configBundle = requireConfig();
        return {
          ...configBundle.active,
          cameraId,
          version: Math.max(...configBundle.versions.map((entry) => entry.version), 0) + 1,
          status: "draft",
          presetName: request.targetName ?? `Preset ${request.sourceVersion}`,
          copiedFromCameraId: request.sourceCameraId,
          copiedFromVersion: request.sourceVersion,
        };
      },
      async deletePreset(cameraId, version) {
        const configBundle = requireConfig();
        return {
          ...configBundle.active,
          cameraId,
          version,
          status: "archived",
        };
      },
      async saveRun(cameraId, config) {
        syncConfig({
          ...config,
          cameraId,
          status: "active",
          activatedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        return requireConfig().active;
      },
      async activate(_cameraId, version) {
        const configBundle = requireConfig();
        return syncConfigBundle({
          ...configBundle.active,
          version,
          status: "active",
          activatedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      },
    },
    destroy() {
      listeners.clear();
    },
  };
}

function buildTestEventHistory(snapshot: LiveStateSnapshot): SystemEvent[] {
  const cameras = snapshot.cameras.slice(0, 2);
  const slotsByCamera = new Map(
    cameras.map((camera) => [
      camera.id,
      flattenSlots(snapshot.levels).filter((slot) => slot.cameraId === camera.id),
    ]),
  );
  const baseTime = Date.parse(snapshot.capturedAt);

  return Array.from({ length: 58 }, (_, index) => {
    const camera = cameras[index % Math.max(cameras.length, 1)] ?? snapshot.cameras[0];
    const cameraSlots = slotsByCamera.get(camera?.id ?? "") ?? [];
    const slot = cameraSlots[index % Math.max(cameraSlots.length, 1)];
    return {
      id: `archive-event-${index + 1}`,
      type: index % 4 === 0 ? "reserved_detected" : "slot_occupied",
      severity: index % 5 === 0 ? "warning" : "info",
      timestamp: new Date(baseTime - index * 60_000).toISOString(),
      message: `Archive follow-up ${index + 1}`,
      slotId: slot?.id,
      levelId: slot?.levelId,
      cameraId: camera?.id,
    } satisfies SystemEvent;
  }).sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
}

function summarizeConfig(config: SpatialConfig): SpatialConfigVersionSummary {
  return {
    cameraId: config.cameraId,
    version: config.version,
    status: config.status,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
    bayCount: config.bays.length,
    zoneCount: config.zones.length,
    lineCount: config.lines.length,
  };
}

function upsertVersion(
  versions: SpatialConfigVersionSummary[],
  nextVersion: SpatialConfigVersionSummary,
): SpatialConfigVersionSummary[] {
  return [...versions.filter((entry) => entry.version !== nextVersion.version), nextVersion].sort(
    (left, right) => left.version - right.version,
  );
}

function pickDefaultSlot(snapshot: LiveStateSnapshot) {
  return flattenSlots(snapshot.levels).find((slot) => slot.status !== "free") ?? snapshot.levels[0]?.slots[0];
}
