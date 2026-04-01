import type { FacilityMetrics, ParkingLevel, SlotStatus } from "../data/types";
import { formatPercent } from "../lib/format";
import { ExportMenu } from "./ExportMenu";

interface DashboardPartitionFilter {
  id: string;
  label: string;
  bayCount: number;
}

interface AnalyticsPanelProps {
  levels: ParkingLevel[];
  partitions: DashboardPartitionFilter[];
  metrics: FacilityMetrics;
  activeFilters: Record<SlotStatus, boolean>;
  activeLevelIds: string[];
  activePartitionIds: string[];
  onToggleFilter(status: SlotStatus): void;
  onToggleLevel(levelId: string): void;
  onTogglePartition(partitionId: string): void;
  onResetFilters(): void;
}

const STATUS_COPY: Record<SlotStatus, string> = {
  free: "Free",
  occupied: "Occupied",
  ev: "EV",
  reserved: "Reserved",
  unknown: "Unknown",
};

export function AnalyticsPanel({
  levels,
  partitions,
  metrics,
  activeFilters,
  activeLevelIds,
  activePartitionIds,
  onToggleFilter,
  onToggleLevel,
  onTogglePartition,
  onResetFilters,
}: AnalyticsPanelProps) {
  const summaryMetrics = [
    { label: "Occ rate", value: formatPercent(metrics.occupancyRate) },
    { label: "Occupied", value: String(metrics.occupiedSlots) },
    { label: "Available", value: String(metrics.freeSlots) },
    { label: "Total bays", value: String(metrics.totalSlots) },
    { label: "EV bays", value: String(metrics.evSlots) },
    { label: "Reserved", value: String(metrics.reservedSlots) },
    { label: "Unknown", value: String(metrics.unknownSlots) },
    { label: "Flags", value: String(metrics.flaggedEvents) },
  ];
  const bayStateCounts = levels
    .filter((level) => activeLevelIds.includes(level.id))
    .flatMap((level) =>
      level.slots.filter((slot) => activePartitionIds.includes(slot.partitionId)),
    )
    .reduce<Record<SlotStatus, number>>(
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

  return (
    <aside className="panel analytics-panel">
      <section className="panel-section">
        <div className="section-heading">
          <h2 className="section-heading__title--nowrap">Occupancy summary</h2>
        </div>

        <div
          className="summary-grid summary-grid--compact"
          role="list"
          aria-label="Occupancy summary metrics"
        >
          {summaryMetrics.map((item) => (
            <div key={item.label} className="summary-grid__cell" role="listitem">
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="panel-section panel-section--grow analytics-panel__filters">
        <div className="section-heading">
          <h2>Filters</h2>
          <button type="button" className="text-button" onClick={onResetFilters}>
            Reset
          </button>
        </div>

        <div className="filter-stack-scroll">
          <div className="filter-stack">
            <div className="filter-stack__group">
              <p className="filter-stack__label">Bay state</p>
              <div
                className="filter-grid filter-grid--stacked"
                role="group"
                aria-label="Filter parking slots"
              >
                {(Object.keys(STATUS_COPY) as SlotStatus[]).map((status) => (
                  <button
                    key={status}
                    type="button"
                    className={`filter-chip filter-chip--thin filter-chip--${status} ${
                      activeFilters[status] ? "is-active" : "is-muted"
                    }`}
                    onClick={() => onToggleFilter(status)}
                  >
                    <span>{STATUS_COPY[status]}</span>
                    <strong>{bayStateCounts[status]}</strong>
                  </button>
                ))}
              </div>
            </div>

            <div className="filter-stack__group">
              <p className="filter-stack__label">Planes</p>
              <div className="plane-filter-strip" role="group" aria-label="Filter parking planes">
                {levels.map((level) => (
                  <button
                    key={level.id}
                    type="button"
                    className={`plane-filter-chip ${
                      activeLevelIds.includes(level.id) ? "is-active" : "is-muted"
                    }`}
                    onClick={() => onToggleLevel(level.id)}
                  >
                    {level.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="filter-stack__group">
              <p className="filter-stack__label">Zones</p>
              <div className="plane-filter-strip" role="group" aria-label="Filter parking zones">
                {partitions.map((partition) => (
                  <button
                    key={partition.id}
                    type="button"
                    className={`plane-filter-chip ${
                      activePartitionIds.includes(partition.id) ? "is-active" : "is-muted"
                    }`}
                    onClick={() => onTogglePartition(partition.id)}
                    title={`${partition.label} · ${partition.bayCount} bays`}
                  >
                    {partition.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <ExportMenu />
    </aside>
  );
}
