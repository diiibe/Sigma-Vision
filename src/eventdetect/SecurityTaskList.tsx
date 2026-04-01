import { useState, useMemo } from "react";
import type { SecurityTask, SecurityEvent, BackendTaskEventCounts } from "./useEventDetection";

interface SecurityTaskListProps {
  tasks: SecurityTask[];
  events: SecurityEvent[];
  activeCameras: string[];
  taskCounts: Record<string, BackendTaskEventCounts>;
  selectedId: string | null;
  onSelect(id: string | null): void;
  onToggle(taskId: string, enabled: boolean): void;
  onDelete(taskId: string): void;
}

const TYPE_LABELS: Record<string, string> = {
  zone_entry: "ENT",
  dwelling: "DWL",
  line_crossing: "LCR",
  running: "RUN",
  chasing: "CHS",
  altercation: "ALT",
  crowd_gathering: "CWD",
};

const TYPE_COLORS: Record<string, string> = {
  zone_entry: "oklch(68% 0.18 85)",
  dwelling: "oklch(65% 0.15 270)",
  line_crossing: "oklch(72% 0.19 220)",
  running: "oklch(70% 0.2 25)",
  chasing: "oklch(68% 0.2 40)",
  altercation: "oklch(80% 0.2 230)",
  crowd_gathering: "oklch(65% 0.18 310)",
};

export function SecurityTaskList({
  tasks,
  events,
  activeCameras,
  taskCounts,
  selectedId,
  onSelect,
  onToggle,
  onDelete,
}: SecurityTaskListProps) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  if (tasks.length === 0) {
    return (
      <div className="ed-observations panel-section panel-section--grow">
        <div className="section-heading ed-observations__header">
          <div>
            <h2>Security Tasks</h2>
            <p>Global and spatial detections grouped by configured task.</p>
          </div>
        </div>
        <p className="ed-observations__empty">No tasks yet. Draw zones or lines to start.</p>
      </div>
    );
  }

  return (
    <div className="ed-observations panel-section panel-section--grow">
      <div className="section-heading ed-observations__header">
        <div>
          <h2>Security Tasks</h2>
          <p>{tasks.length} configured task{tasks.length !== 1 ? "s" : ""} across cameras and zones.</p>
        </div>
      </div>

      <div className="ed-observations__list">
        {tasks.map((task) => {
          const isSelected = selectedId === task.id;
          const isActive = activeCameras.includes(task.cameraId);
          const counts = taskCounts[task.id] ?? { total: 0 };

          return (
            <div
              key={task.id}
              className={`ed-observations__item ${isSelected ? "is-selected" : ""} ${!task.enabled ? "is-disabled" : ""}`}
              onClick={() => onSelect(isSelected ? null : task.id)}
            >
              <span className={`ed-observations__status ${isActive ? "is-active" : ""}`} />

              <div className="ed-observations__info">
                <span className="ed-observations__name">
                  {task.zones.find((z) => z.name && z.name !== "Full frame")?.name
                    ?? task.zones.find((z) => z.name === "Full frame")?.name
                    ?? task.id.slice(0, 12)}
                </span>
                <span className="ed-observations__cam">{task.cameraId}</span>
                <div className="ed-observations__badges">
                  {/* Global events */}
                  {task.zones.some((z) => z.detectRunning) && (
                    <span className="ed-observations__badge ed-observations__badge--global">RUN</span>
                  )}
                  {task.zones.some((z) => z.detectChasing) && (
                    <span className="ed-observations__badge ed-observations__badge--global">CHS</span>
                  )}
                  {task.zones.some((z) => z.detectAltercation) && (
                    <span className="ed-observations__badge ed-observations__badge--global">ALT</span>
                  )}
                  {task.zones.some((z) => z.detectCrowdGathering) && (
                    <span className="ed-observations__badge ed-observations__badge--global">CWD</span>
                  )}
                  {/* Spatial events */}
                  {task.zones.filter((z) => z.detectEntry).length > 0 && (
                    <span className="ed-observations__badge ed-observations__badge--spatial">
                      ENT {task.zones.filter((z) => z.detectEntry && z.name !== "Full frame").length > 0
                        ? `×${task.zones.filter((z) => z.detectEntry && z.name !== "Full frame").length}` : ""}
                    </span>
                  )}
                  {task.zones.filter((z) => z.detectDwelling).length > 0 && (
                    <span className="ed-observations__badge ed-observations__badge--spatial">
                      DWL {task.zones.filter((z) => z.detectDwelling && z.name !== "Full frame").length > 0
                        ? `×${task.zones.filter((z) => z.detectDwelling && z.name !== "Full frame").length}` : ""}
                    </span>
                  )}
                </div>
              </div>

              {counts.total > 0 && (
                <span className="ed-observations__count">{counts.total}</span>
              )}

              <div className="ed-observations__actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="text-button ed-observations__action-btn"
                  title={task.enabled ? "Stop" : "Start"}
                  onClick={() => onToggle(task.id, !task.enabled)}
                >
                  {task.enabled ? "●" : "○"}
                </button>

                {confirmDelete === task.id ? (
                  <>
                    <button
                      className="text-button ed-observations__action-btn ed-observations__action-btn--danger"
                      onClick={() => { onDelete(task.id); setConfirmDelete(null); }}
                    >
                      ✓
                    </button>
                    <button
                      className="text-button ed-observations__action-btn"
                      onClick={() => setConfirmDelete(null)}
                    >
                      ✕
                    </button>
                  </>
                ) : (
                  <button
                    className="text-button ed-observations__action-btn ed-observations__action-btn--danger"
                    onClick={() => setConfirmDelete(task.id)}
                  >
                    🗑
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Event stats mini panel (shown below task list) ──

interface EventStatsProps {
  events: SecurityEvent[];
  cameraId: string | null;
}

export function EventStats({ events, cameraId }: EventStatsProps) {
  const filtered = useMemo(
    () => (cameraId ? events.filter((e) => e.cameraId === cameraId) : events),
    [events, cameraId],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of filtered) {
      c[e.eventType] = (c[e.eventType] || 0) + 1;
    }
    return c;
  }, [filtered]);

  const recent = useMemo(
    () => [...filtered].reverse().slice(0, 5),
    [filtered],
  );

  return (
    <section className="ed-stats panel-section">
      <div className="section-heading ed-stats__heading">
        <div>
          <h2>Event Stats</h2>
          <p>Recent detections and per-type counts for the active camera context.</p>
        </div>
      </div>
      {Object.keys(counts).length > 0 && (
        <div className="ed-stats__counts">
          {Object.entries(counts).map(([type, n]) => (
            <span key={type} className="ed-stats__count-badge" style={{ borderColor: TYPE_COLORS[type] }}>
              <span className="ed-stats__count-label">{TYPE_LABELS[type] ?? type}</span>
              <span className="ed-stats__count-value">{n}</span>
            </span>
          ))}
        </div>
      )}

      {recent.length > 0 && (
        <div className="ed-stats__recent">
          {recent.map((ev) => (
            <div key={ev.id} className="ed-stats__recent-row">
              <span className="ed-stats__recent-badge" style={{ background: TYPE_COLORS[ev.eventType] }}>
                {TYPE_LABELS[ev.eventType] ?? ev.eventType}
              </span>
              <span className="ed-stats__recent-conf">{(ev.confidence * 100).toFixed(0)}%</span>
              <span className="ed-stats__recent-time">
                {new Date(ev.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
              <a
                className="ed-stats__recent-clip"
                href={`/api/security/clip/${ev.id}`}
                download={`${ev.id}.mp4`}
                onClick={(e) => e.stopPropagation()}
                title="Download 5s clip"
              >
                clip
              </a>
            </div>
          ))}
        </div>
      )}

      {filtered.length === 0 && (
        <p className="ed-stats__empty">No events detected yet.</p>
      )}
    </section>
  );
}
