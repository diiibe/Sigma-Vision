import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { ParkingLevel, ParkingSlot, SystemEvent } from "../data/types";
import { findSlotById, flattenSlots } from "../data/dashboardUtils";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { ParkingScene } from "../scene/ParkingScene";
import { buildMockSlotOverlayMetrics } from "../scene/slotOverlay";
import { useDashboardStore } from "../store/dashboardStore";
import { AnalyticsPanel } from "./AnalyticsPanel";
import { MonitoringPanel } from "./MonitoringPanel";
import { SceneViewport } from "./SceneViewport";
import { TopBar } from "./TopBar";
import { useParkingClient } from "../api/parkingClientContext";
import { resolveTimeZone } from "../lib/timeZone";

interface TacticalDashboardProps {
  onOpenEditor?(): void;
  onOpenCounting?(): void;
  onOpenEvents?(): void;
}

interface DashboardPartitionFilter {
  id: string;
  levelId: string;
  label: string;
  bayCount: number;
}

export function TacticalDashboard({ onOpenEditor, onOpenCounting, onOpenEvents }: TacticalDashboardProps) {
  const client = useParkingClient();
  const reducedMotion = useReducedMotion();
  const previousAvailableLevelIdsRef = useRef<string[]>([]);
  const previousAvailablePartitionIdsRef = useRef<string[]>([]);
  const snapshot = useSyncExternalStore(
    client.live.subscribe,
    client.live.getSnapshot,
    client.live.getSnapshot,
  );
  const activeSnapshotCameraId = snapshot?.activeCameraId ?? snapshot?.config?.active.cameraId ?? null;
  const hasSnapshot = snapshot !== null;
  const timeZone = resolveTimeZone(snapshot?.timeZone);

  useEffect(() => {
    document.body.classList.add("dashboard-route");

    return () => {
      document.body.classList.remove("dashboard-route");
    };
  }, []);

  const {
    selectedSlotId,
    selectedCameraId,
    trackedSlotId,
    hoveredSlotId,
    isDetailCardOpen,
    activeFilters,
    activeLevelIds,
    activePartitionIds,
    activeOverlays,
    setSelectedSlot,
    setSelectedLevel,
    setSelectedCamera,
    setTrackedSlot,
    setHoveredSlot,
    setActiveLevelIds,
    setActivePartitionIds,
    closeDetailCard,
    toggleFilter,
    toggleOverlay,
    resetFilters,
  } = useDashboardStore();

  useEffect(() => {
    if (!selectedCameraId && hasSnapshot) {
      return;
    }
    if (selectedCameraId && selectedCameraId === activeSnapshotCameraId) {
      return;
    }
    void client.live.refresh(selectedCameraId ?? undefined);
  }, [activeSnapshotCameraId, client, hasSnapshot, selectedCameraId]);

  const allSlots = useMemo(() => flattenSlots(snapshot?.levels ?? []), [snapshot?.levels]);
  const orderedLevels = useMemo(
    () => [...(snapshot?.levels ?? [])].sort((left, right) => left.index - right.index),
    [snapshot?.levels],
  );
  const availableLevelIds = useMemo(
    () => orderedLevels.map((level) => level.id),
    [orderedLevels],
  );
  const orderedPartitions = useMemo(
    () =>
      buildDashboardPartitionFilters(
        snapshot?.config?.active?.partitions ?? [],
        orderedLevels,
        allSlots,
      ),
    [allSlots, orderedLevels, snapshot?.config?.active?.partitions],
  );
  const availablePartitionIds = useMemo(
    () => orderedPartitions.map((partition) => partition.id),
    [orderedPartitions],
  );
  const effectiveActiveLevelIds = useMemo(() => {
    const validLevelIds = activeLevelIds.filter((levelId) =>
      availableLevelIds.includes(levelId),
    );

    return validLevelIds.length > 0 ? validLevelIds : availableLevelIds;
  }, [activeLevelIds, availableLevelIds]);
  const effectiveActivePartitionIds = useMemo(() => {
    const validPartitionIds = activePartitionIds.filter((partitionId) =>
      availablePartitionIds.includes(partitionId),
    );

    return validPartitionIds.length > 0 ? validPartitionIds : availablePartitionIds;
  }, [activePartitionIds, availablePartitionIds]);

  useEffect(() => {
    const reconciledLevelIds = reconcileActiveLevelIds(
      activeLevelIds,
      availableLevelIds,
      previousAvailableLevelIdsRef.current,
    );
    previousAvailableLevelIdsRef.current = availableLevelIds;
    if (reconciledLevelIds) {
      setActiveLevelIds(reconciledLevelIds);
    }
  }, [activeLevelIds, availableLevelIds, setActiveLevelIds]);
  useEffect(() => {
    const reconciledPartitionIds = reconcileActiveLevelIds(
      activePartitionIds,
      availablePartitionIds,
      previousAvailablePartitionIdsRef.current,
    );
    previousAvailablePartitionIdsRef.current = availablePartitionIds;
    if (reconciledPartitionIds) {
      setActivePartitionIds(reconciledPartitionIds);
    }
  }, [activePartitionIds, availablePartitionIds, setActivePartitionIds]);
  const effectiveSelectedSlotId = selectedSlotId;
  const selectedSlot = findSlotById(snapshot?.levels ?? [], effectiveSelectedSlotId) ?? null;
  const selectedCamera =
    snapshot?.cameras.find(
      (camera) => camera.id === (selectedCameraId ?? selectedSlot?.cameraId),
    ) ?? snapshot?.cameras[0] ?? null;
  const slotOverlayMetrics = useMemo(() => buildMockSlotOverlayMetrics(snapshot?.levels ?? []), [
    snapshot?.levels,
  ]);
  const filteredLevels = useMemo(
    () =>
      orderedLevels
        .filter((level) => effectiveActiveLevelIds.includes(level.id))
        .map((level) => ({
          ...level,
          slots: level.slots.filter((slot) => effectiveActivePartitionIds.includes(slot.partitionId)),
        })),
    [effectiveActiveLevelIds, effectiveActivePartitionIds, orderedLevels],
  );
  const filteredSlots = useMemo(() => flattenSlots(filteredLevels), [filteredLevels]);
  const cameraRelevantPartitionIds = useMemo(
    () => getCameraRelevantPartitionIds(filteredSlots, selectedCamera?.id ?? null),
    [filteredSlots, selectedCamera?.id],
  );
  const cameraRelevantSlotIds = useMemo(
    () => getCameraRelevantSlotIds(filteredSlots, selectedCamera?.id ?? null),
    [filteredSlots, selectedCamera?.id],
  );
  const cameraRelevantPartitions = useMemo(
    () =>
      getCameraRelevantPartitions(
        filteredLevels,
        cameraRelevantPartitionIds,
        filteredSlots,
        snapshot?.config?.active ?? null,
      ),
    [cameraRelevantPartitionIds, filteredLevels, filteredSlots, snapshot?.config?.active],
  );
  const handleSelectSlot = (slotId: string) => {
    const slot = findSlotById(snapshot?.levels ?? [], slotId);
    setSelectedSlot(slotId);

    if (slot) {
      if (!effectiveActiveLevelIds.includes(slot.levelId)) {
        setActiveLevelIds(
          availableLevelIds.filter((levelId) =>
            [...effectiveActiveLevelIds, slot.levelId].includes(levelId),
          ),
        );
      }
      if (!effectiveActivePartitionIds.includes(slot.partitionId)) {
        setActivePartitionIds(
          availablePartitionIds.filter((partitionId) =>
            [...effectiveActivePartitionIds, slot.partitionId].includes(partitionId),
          ),
        );
      }

      setSelectedLevel(slot.levelId);
      setSelectedCamera(slot.cameraId);
    }
  };

  const handleSelectCamera = (cameraId: string) => {
    const camera = snapshot?.cameras.find((entry) => entry.id === cameraId);
    setSelectedCamera(cameraId);
    setSelectedSlot(null);
    setHoveredSlot(null);
    void client.live.refresh(cameraId);

    if (camera) {
      if (!effectiveActiveLevelIds.includes(camera.levelId)) {
        setActiveLevelIds(
          availableLevelIds.filter((levelId) =>
            [...effectiveActiveLevelIds, camera.levelId].includes(levelId),
          ),
        );
      }

      setSelectedLevel(camera.levelId);
    }
  };

  const handleSelectEvent = (event: SystemEvent) => {
    if (event.slotId) {
      handleSelectSlot(event.slotId);
      return;
    }

    if (event.cameraId) {
      handleSelectCamera(event.cameraId);
    }
  };

  const handleReserveSelectedSlot = async () => {
    if (!selectedSlot) {
      return;
    }

    if (client.live.reserveBay) {
      await client.live.reserveBay(selectedSlot.id);
    }
  };

  const handleClearSelectedSlot = async () => {
    if (!selectedSlot) {
      return;
    }

    if (client.live.clearBayOverride) {
      await client.live.clearBayOverride(selectedSlot.id);
    }
  };

  const handleTrackSelectedSlot = () => {
    if (!selectedSlot) {
      return;
    }

    setTrackedSlot(selectedSlot.id);
  };

  const handleToggleLevel = (levelId: string) => {
    const nextActiveLevelIds = effectiveActiveLevelIds.includes(levelId)
      ? effectiveActiveLevelIds.length > 1
        ? effectiveActiveLevelIds.filter((activeLevelId) => activeLevelId !== levelId)
        : effectiveActiveLevelIds
      : availableLevelIds.filter((activeLevelId) =>
          [...effectiveActiveLevelIds, levelId].includes(activeLevelId),
        );

    setActiveLevelIds(nextActiveLevelIds);

    if (selectedSlot && !nextActiveLevelIds.includes(selectedSlot.levelId)) {
      setSelectedSlot(null);
      setHoveredSlot(null);
      setSelectedLevel(null);
      closeDetailCard();
      return;
    }

    if (hoveredSlotId) {
      const hoveredSlot = findSlotById(snapshot?.levels ?? [], hoveredSlotId);

      if (hoveredSlot && !nextActiveLevelIds.includes(hoveredSlot.levelId)) {
        setHoveredSlot(null);
      }
    }
  };

  const handleTogglePartition = (partitionId: string) => {
    const nextActivePartitionIds = effectiveActivePartitionIds.includes(partitionId)
      ? effectiveActivePartitionIds.length > 1
        ? effectiveActivePartitionIds.filter((activePartitionId) => activePartitionId !== partitionId)
        : effectiveActivePartitionIds
      : availablePartitionIds.filter((activePartitionId) =>
          [...effectiveActivePartitionIds, partitionId].includes(activePartitionId),
        );

    setActivePartitionIds(nextActivePartitionIds);

    if (selectedSlot && !nextActivePartitionIds.includes(selectedSlot.partitionId)) {
      setSelectedSlot(null);
      setHoveredSlot(null);
      closeDetailCard();
      return;
    }

    if (hoveredSlotId) {
      const hoveredSlot = findSlotById(snapshot?.levels ?? [], hoveredSlotId);

      if (hoveredSlot && !nextActivePartitionIds.includes(hoveredSlot.partitionId)) {
        setHoveredSlot(null);
      }
    }
  };

  return (
    <main className="dashboard-shell">
      <TopBar
        systemStatus={snapshot?.systemStatus ?? "degraded"}
        connectionHealth={snapshot?.connectionHealth ?? "degraded"}
        timeZone={timeZone}
        onOpenEditor={onOpenEditor}
        onOpenCounting={onOpenCounting}
        onOpenEvents={onOpenEvents}
      />

      <div className="dashboard-grid">
        <AnalyticsPanel
          levels={orderedLevels}
          partitions={orderedPartitions}
          metrics={snapshot?.metrics ?? emptyMetrics()}
          activeFilters={activeFilters}
          activeLevelIds={effectiveActiveLevelIds}
          activePartitionIds={effectiveActivePartitionIds}
          onToggleFilter={toggleFilter}
          onToggleLevel={handleToggleLevel}
          onTogglePartition={handleTogglePartition}
          onResetFilters={resetFilters}
        />

        <SceneViewport
          levels={orderedLevels}
          selectedSlot={selectedSlot}
          selectedCamera={selectedCamera}
          timeZone={timeZone}
          trackedSlotId={trackedSlotId}
          cameraRelevantPartitionIds={cameraRelevantPartitionIds}
          cameraRelevantSlotIds={cameraRelevantSlotIds}
          isDetailCardOpen={isDetailCardOpen}
          selectedSlotId={effectiveSelectedSlotId}
          hoveredSlotId={hoveredSlotId}
          activeFilters={activeFilters}
          activeLevelIds={effectiveActiveLevelIds}
          activePartitionIds={effectiveActivePartitionIds}
          activeOverlays={activeOverlays}
          slotOverlayMetrics={slotOverlayMetrics}
          reducedMotion={reducedMotion}
          onHoverSlot={setHoveredSlot}
          onSelectSlot={handleSelectSlot}
          onToggleOverlay={toggleOverlay}
          onReserveSlot={handleReserveSelectedSlot}
          onMarkAvailable={handleClearSelectedSlot}
          onTrackSlot={handleTrackSelectedSlot}
          onCloseDetailCard={closeDetailCard}
          SceneComponent={ParkingScene}
        />

        <MonitoringPanel
          cameras={snapshot?.cameras ?? []}
          slots={filteredSlots}
          moduleHealth={snapshot?.moduleHealth ?? []}
          events={snapshot?.events ?? []}
          timeZone={timeZone}
          selectedCameraId={selectedCamera?.id ?? null}
          selectedSlotId={selectedSlot?.id ?? null}
          trackedSlotId={trackedSlotId}
          cameraRelevantPartitions={cameraRelevantPartitions}
          cameraRelevantPartitionIds={cameraRelevantPartitionIds}
          cameraRelevantSlotIds={cameraRelevantSlotIds}
          onSelectCamera={handleSelectCamera}
          onSelectSlot={handleSelectSlot}
          onSelectEvent={handleSelectEvent}
        />
      </div>
    </main>
  );
}

function getCameraRelevantPartitionIds(
  slots: ParkingSlot[],
  cameraId: string | null,
) {
  if (!cameraId) {
    return [] as string[];
  }

  return Array.from(
    new Set(
      slots
        .filter((slot) => slot.cameraId === cameraId)
        .map((slot) => slot.partitionId),
    ),
  );
}

function getCameraRelevantSlotIds(
  slots: ParkingSlot[],
  cameraId: string | null,
) {
  if (!cameraId) {
    return [] as string[];
  }

  return slots
    .filter((slot) => slot.cameraId === cameraId)
    .map((slot) => slot.id);
}

function getCameraRelevantPartitions(
  levels: { id: string; name: string }[],
  relevantPartitionIds: string[],
  slots: ParkingSlot[],
  config: { partitions: { id: string; name: string }[] } | null,
) {
  if (relevantPartitionIds.length === 0) {
    return [];
  }

  const partitionIdSet = new Set(relevantPartitionIds);
  const fromLevels = levels
    .filter((level) => partitionIdSet.has(level.id))
    .map((level) => ({
      id: level.id,
      name: level.name,
      ownerCameraIds: Array.from(
        new Set(
          slots
            .filter((slot) => slot.partitionId === level.id)
            .map((slot) => slot.cameraId),
        ),
      ),
    }));
  if (fromLevels.length > 0) {
    return fromLevels;
  }

  return (config?.partitions ?? [])
    .filter((partition) => partitionIdSet.has(partition.id))
    .map((partition) => ({
      id: partition.id,
      name: partition.name,
      ownerCameraIds: Array.from(
        new Set(
          slots
            .filter((slot) => slot.partitionId === partition.id)
            .map((slot) => slot.cameraId),
        ),
      ),
    }));
}

function emptyMetrics() {
  return {
    totalSlots: 0,
    occupiedSlots: 0,
    freeSlots: 0,
    evSlots: 0,
    reservedSlots: 0,
    unknownSlots: 0,
    occupancyRate: 0,
    onlineSensors: 0,
    flaggedEvents: 0,
    levelStats: [],
  };
}

export function reconcileActiveLevelIds(
  activeLevelIds: string[],
  availableLevelIds: string[],
  previousAvailableLevelIds: string[] = [],
) {
  if (activeLevelIds.length === 0 || availableLevelIds.length === 0) {
    return null;
  }

  const validLevelIds = activeLevelIds.filter((levelId) => availableLevelIds.includes(levelId));
  const newlyAvailableLevelIds = availableLevelIds.filter(
    (levelId) =>
      !previousAvailableLevelIds.includes(levelId) &&
      !validLevelIds.includes(levelId),
  );
  const nextLevelIds = [...validLevelIds, ...newlyAvailableLevelIds];

  if (
    nextLevelIds.length === activeLevelIds.length &&
    nextLevelIds.every((levelId, index) => levelId === activeLevelIds[index])
  ) {
    return null;
  }

  return nextLevelIds;
}

function buildDashboardPartitionFilters(
  partitions: { id: string; levelId: string; order: number }[],
  levels: ParkingLevel[],
  slots: ParkingSlot[],
): DashboardPartitionFilter[] {
  const levelById = new Map(levels.map((level) => [level.id, level] as const));
  const partitionsByLevel = new Map<string, { id: string; levelId: string; order: number }[]>();

  for (const partition of partitions) {
    const current = partitionsByLevel.get(partition.levelId) ?? [];
    current.push(partition);
    partitionsByLevel.set(partition.levelId, current);
  }

  return [...partitions]
    .sort((left, right) => {
      const leftLevelIndex = levelById.get(left.levelId)?.index ?? Number.MAX_SAFE_INTEGER;
      const rightLevelIndex = levelById.get(right.levelId)?.index ?? Number.MAX_SAFE_INTEGER;
      return leftLevelIndex - rightLevelIndex || left.order - right.order || left.id.localeCompare(right.id);
    })
    .map((partition) => {
      const level = levelById.get(partition.levelId);
      const planeNumber = (level?.index ?? 0) + 1;
      const zoneNumber =
        (partitionsByLevel.get(partition.levelId) ?? [])
          .slice()
          .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
          .findIndex((entry) => entry.id === partition.id) + 1;

      return {
        id: partition.id,
        levelId: partition.levelId,
        label: `Zone ${planeNumber}.${Math.max(zoneNumber, 1)}`,
        bayCount: slots.filter((slot) => slot.partitionId === partition.id).length,
      };
    });
}
