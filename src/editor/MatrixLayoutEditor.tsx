import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getLotLevels } from "../data/lotMatrix";
import type { LayoutPartitionDefinition, LotDefinition } from "../data/types";

interface MatrixLayoutEditorProps {
  lotDefinition: LotDefinition;
  selectedCameraId: string | null;
  selectedLevelId: string | null;
  selectedPartitionId: string | null;
  selectedSlotId: string | null;
  onSelectLevel(levelId: string): void;
  onSelectPartition(partitionId: string): void;
  onSelectSlot(slotId: string | null): void;
  onCreateSlot(levelId: string, partitionId: string, row: number, column: number): void;
}

export function MatrixLayoutEditor({
  lotDefinition,
  selectedLevelId,
  selectedPartitionId,
  selectedSlotId,
  onSelectLevel,
  onSelectPartition,
  onSelectSlot,
  onCreateSlot,
}: MatrixLayoutEditorProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const zoneCardRefs = useRef<Record<string, HTMLElement | null>>({});
  const panningRef = useRef<
    | { startX: number; startY: number; startScrollLeft: number; startScrollTop: number }
    | null
  >(null);
  const [isPanning, setIsPanning] = useState(false);
  const levels = getLotLevels(lotDefinition);
  const activeLevel = levels.find((level) => level.id === selectedLevelId) ?? levels[0] ?? null;
  const levelZones = useMemo(() => getLevelZones(lotDefinition, activeLevel?.id ?? null), [
    activeLevel?.id,
    lotDefinition,
  ]);
  const activeZone =
    levelZones.find((zone) => zone.id === selectedPartitionId) ?? levelZones[0] ?? null;

  useEffect(() => {
    if (activeZone && selectedPartitionId !== activeZone.id) {
      onSelectPartition(activeZone.id);
    }
  }, [activeZone, onSelectPartition, selectedPartitionId]);

  useEffect(() => {
    const activeZoneCard = activeZone ? zoneCardRefs.current[activeZone.id] : null;
    if (!activeZoneCard || typeof activeZoneCard.scrollIntoView !== "function") {
      return;
    }

    activeZoneCard.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "smooth",
    });
  }, [activeZone]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const viewport = viewportRef.current;
      const activePan = panningRef.current;
      if (!viewport || !activePan) {
        return;
      }

      viewport.scrollLeft = clampScroll(
        activePan.startScrollLeft - (event.clientX - activePan.startX),
        viewport.scrollWidth - viewport.clientWidth,
      );
      viewport.scrollTop = clampScroll(
        activePan.startScrollTop - (event.clientY - activePan.startY),
        viewport.scrollHeight - viewport.clientHeight,
      );
      setIsPanning(true);
    };

    const stopPanning = () => {
      panningRef.current = null;
      setIsPanning(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopPanning);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopPanning);
    };
  }, []);

  return (
    <section className={`editor-canvas editor-canvas--matrix ${levels.length === 1 ? "is-single-plane" : ""}`}>
      <header className="editor-canvas__header">
        <div>
          <h2>3D matrix planes</h2>
          <p>Select a plane, use the zone buttons for focus, then edit all zone matrices below.</p>
        </div>
      </header>

      <div className="matrix-editor">
        <div className="matrix-plane-tabs" role="tablist" aria-label="Plane navigation">
          {levels.map((level) => (
            <button
              key={level.id}
              type="button"
              role="tab"
              aria-selected={activeLevel?.id === level.id}
              className={`matrix-plane-tab ${activeLevel?.id === level.id ? "is-active" : ""}`}
              onClick={() => onSelectLevel(level.id)}
            >
              <span>{level.name}</span>
              <strong>
                {lotDefinition.slots.filter((slot) => slot.levelId === level.id).length}
              </strong>
            </button>
          ))}
        </div>

        {activeLevel ? (
          <div className="matrix-plane-tabs matrix-plane-tabs--zone" role="tablist" aria-label="Zone navigation">
            {levelZones.map((zone, index) => {
              const zoneName = getZoneDisplayName(zone, index, activeLevel.name);
              const zoneCount = lotDefinition.slots.filter((slot) => slot.partitionId === zone.id).length;

              return (
                <button
                  key={zone.id}
                  type="button"
                  role="tab"
                  aria-selected={activeZone?.id === zone.id}
                  className={`matrix-plane-tab ${activeZone?.id === zone.id ? "is-active" : ""}`}
                  onClick={() => {
                    onSelectLevel(activeLevel.id);
                    onSelectPartition(zone.id);
                    zoneCardRefs.current[zone.id]?.scrollIntoView?.({
                      block: "nearest",
                      inline: "nearest",
                      behavior: "smooth",
                    });
                  }}
                >
                  <span>{zoneName}</span>
                  <strong>{zoneCount}</strong>
                </button>
              );
            })}
          </div>
        ) : null}

        {activeLevel && levelZones.length > 0 ? (
          <div
            ref={viewportRef}
            className={`matrix-editor__viewport ${isPanning ? "is-panning" : ""}`}
            tabIndex={0}
            aria-label="Matrix plane viewport"
            onPointerDown={(event) => {
              const target = event.target as HTMLElement;
              if (target.closest("button")) {
                return;
              }

              event.preventDefault();
              panningRef.current = {
                startX: event.clientX,
                startY: event.clientY,
                startScrollLeft: event.currentTarget.scrollLeft,
                startScrollTop: event.currentTarget.scrollTop,
              };
              setIsPanning(true);
            }}
          >
            <div className="matrix-editor__stage matrix-editor__zone-list">
              {levelZones.map((zone, index) => {
                const previewWidth = Math.max(544, zone.gridColumns * 74);
                const isActiveZone = activeZone?.id === zone.id;
                const zoneName = getZoneDisplayName(zone, index, activeLevel.name);
                const zoneSlots = lotDefinition.slots.filter((slot) => slot.partitionId === zone.id);

                return (
                  <article
                    key={zone.id}
                    ref={(node) => {
                      zoneCardRefs.current[zone.id] = node;
                    }}
                    className={`matrix-plane matrix-plane--preview ${isActiveZone ? "is-active" : ""}`}
                    style={{
                      "--plane-index": activeLevel.index,
                      width: `${previewWidth}px`,
                    } as CSSProperties}
                    aria-label={`${zoneName} matrix`}
                    tabIndex={-1}
                  >
                    <div className="matrix-plane__header">
                      <span>{zoneName}</span>
                      <strong>{zoneSlots.length} bays</strong>
                    </div>

                    <div
                      className="matrix-plane__grid"
                      style={{
                        gridTemplateColumns: `repeat(${Math.max(zone.gridColumns, 1)}, minmax(0, 1fr))`,
                      }}
                    >
                      {buildZoneCells(
                        zone,
                        lotDefinition,
                        Math.max(zone.gridRows, 1),
                        Math.max(zone.gridColumns, 1),
                      ).map(({ row, column, slot }) =>
                        slot ? (
                          <button
                            key={slot.id}
                            type="button"
                            className={`matrix-slot-tile matrix-slot-tile--${slot.evCapable ? "ev" : "standard"} ${
                              selectedSlotId === slot.id ? "is-active" : ""
                            }`}
                            onClick={() => {
                              onSelectLevel(activeLevel.id);
                              onSelectPartition(zone.id);
                              onSelectSlot(selectedSlotId === slot.id ? null : slot.id);
                            }}
                          >
                            <span>{slot.label}</span>
                            <strong>
                              R{slot.row + 1} · C{slot.column + 1}
                            </strong>
                          </button>
                        ) : (
                          <button
                            key={`${zone.id}-${row}-${column}`}
                            type="button"
                            className="matrix-plane__cell matrix-plane__cell--empty"
                            onClick={() => onCreateSlot(activeLevel.id, zone.id, row, column)}
                          >
                            Add bay
                          </button>
                        ),
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function clampScroll(value: number, max: number) {
  return Math.min(Math.max(0, value), Math.max(0, max));
}

function getLevelZones(lotDefinition: LotDefinition, levelId: string | null) {
  const zones = lotDefinition.partitions
    .filter((partition) => partition.levelId === levelId)
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));

  if (zones.length > 0) {
    return zones;
  }

  if (!levelId) {
    return [];
  }

  const level = getLotLevels(lotDefinition).find((entry) => entry.id === levelId);
  if (!level) {
    return [];
  }

  return [
    {
      id: level.id,
      name: "Zone 01",
      levelId: level.id,
      order: 0,
      gridRows: Math.max(level.gridRows, 1),
      gridColumns: Math.max(level.gridColumns, 1),
      ownerCameraIds: [],
      layoutPolygon: null,
    } satisfies LayoutPartitionDefinition,
  ];
}

function buildZoneCells(
  zone: LayoutPartitionDefinition,
  lotDefinition: LotDefinition,
  rows: number,
  columns: number,
) {
  const zoneSlots = lotDefinition.slots.filter((slot) => slot.partitionId === zone.id);
  const slotByCell = new Map(zoneSlots.map((slot) => [`${slot.row}:${slot.column}`, slot] as const));

  return Array.from({ length: rows * columns }, (_, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;

    return {
      row,
      column,
      slot: slotByCell.get(`${row}:${column}`) ?? null,
    };
  });
}

function getZoneDisplayName(
  zone: LayoutPartitionDefinition,
  index: number,
  levelName?: string,
) {
  const rawName = zone.name.trim();
  const fallbackName = `Zone ${String(index + 1).padStart(2, "0")}`;

  if (!rawName) {
    return fallbackName;
  }

  const normalizedName = rawName.toLowerCase();
  const normalizedLevelName = levelName?.trim().toLowerCase();

  if (
    normalizedName === normalizedLevelName ||
    /^plane\s+\d+/i.test(rawName) ||
    /^partition\s+\d+/i.test(rawName)
  ) {
    return fallbackName;
  }

  return rawName;
}
