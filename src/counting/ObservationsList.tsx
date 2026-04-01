import { useState } from "react";
import type { ObservationDefinition } from "../data/types";
import type { ObservationLiveData, PairSummary } from "./useObservationLiveData";

interface ObservationsListProps {
  observations: ObservationDefinition[];
  liveData: ObservationLiveData;
  selectedId: string | null;
  onSelect(id: string | null): void;
  onToggle(id: string, enabled: boolean): void;
  onEdit(id: string): void;
  onDelete(id: string): void;
  onDuplicate(id: string): void;
}

type GroupBy = "association" | "camera";

export function ObservationsList({
  observations,
  liveData,
  selectedId,
  onSelect,
  onToggle,
  onEdit,
  onDelete,
  onDuplicate,
}: ObservationsListProps) {
  const [groupBy, setGroupBy] = useState<GroupBy>("association");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  if (observations.length === 0) {
    return (
      <div className="va-observations panel-section panel-section--grow">
        <div className="section-heading va-observations__header">
          <div>
            <h2>Observations</h2>
            <p>Task definitions grouped by association or source camera.</p>
          </div>
        </div>
        <p className="va-observations__empty">
          No observations defined. Use the setup panel to create one.
        </p>
      </div>
    );
  }

  const groups: { key: string; label: string; pair: PairSummary | null; items: ObservationDefinition[] }[] = [];

  if (groupBy === "association") {
    for (const pair of liveData.pairs) {
      groups.push({
        key: `${pair.associationType}::${pair.associationId ?? ""}`,
        label: pair.label,
        pair,
        items: pair.observations,
      });
    }
  } else {
    const byCam = new Map<string, ObservationDefinition[]>();
    for (const obs of observations) {
      const list = byCam.get(obs.cameraId) ?? [];
      list.push(obs);
      byCam.set(obs.cameraId, list);
    }
    for (const [camId, items] of byCam) {
      groups.push({ key: camId, label: camId, pair: null, items });
    }
  }

  return (
    <div className="va-observations panel-section panel-section--grow">
      <div className="section-heading va-observations__header">
        <div>
          <h2>Observations</h2>
          <p>Review live counts, selection state, and task controls.</p>
        </div>
        <div className="va-observations__group-toggle">
          <button
            type="button"
            className={`action-button action-button--compact va-observations__group-btn ${groupBy === "association" ? "is-active" : ""}`}
            onClick={() => setGroupBy("association")}
          >
            By Assoc.
          </button>
          <button
            type="button"
            className={`action-button action-button--compact va-observations__group-btn ${groupBy === "camera" ? "is-active" : ""}`}
            onClick={() => setGroupBy("camera")}
          >
            By Camera
          </button>
        </div>
      </div>

      <div className="va-observations__list">
        {groups.map((group) => (
          <div key={group.key} className="va-observations__group">
            <div className="va-observations__group-header">
              <span className="va-observations__group-label">{group.label}</span>
            </div>
            {group.items.map((obs) => {
              const entry = liveData.byId.get(obs.id);
              const liveCount = entry?.liveCount ?? 0;
              const isOverThreshold =
                obs.taskType === "density" &&
                obs.capacityThreshold != null &&
                liveCount > obs.capacityThreshold;

              return (
                <div
                  key={obs.id}
                  className={`va-observations__item ${
                    selectedId === obs.id ? "is-selected" : ""
                  } ${isOverThreshold ? "is-alert" : ""} ${
                    !obs.enabled ? "is-disabled" : ""
                  }`}
                  onClick={() => onSelect(obs.id === selectedId ? null : obs.id)}
                >
                  {/* Status dot */}
                  <span
                    className={`va-observations__status ${obs.enabled ? "is-active" : ""}`}
                  />

                  {/* Type badge */}
                  <span className={`va-observations__badge va-observations__badge--${obs.taskType}`}>
                    {obs.taskType === "entry"
                      ? "IN"
                      : obs.taskType === "exit"
                        ? "OUT"
                        : "DEN"}
                  </span>

                  {/* Name */}
                  <span className="va-observations__name">{obs.name}</span>

                  {/* Actions */}
                  <div className="va-observations__actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="text-button va-observations__action-btn"
                      title={obs.enabled ? "Deactivate" : "Activate"}
                      onClick={() => onToggle(obs.id, !obs.enabled)}
                    >
                      {obs.enabled ? "●" : "○"}
                    </button>
                    <button
                      type="button"
                      className="text-button va-observations__action-btn"
                      title="Edit"
                      onClick={() => onEdit(obs.id)}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="text-button va-observations__action-btn"
                      title="Duplicate"
                      onClick={() => onDuplicate(obs.id)}
                    >
                      ⧉
                    </button>
                    {confirmDelete === obs.id ? (
                      <>
                        <button
                          type="button"
                          className="text-button va-observations__action-btn va-observations__action-btn--danger"
                          onClick={() => {
                            onDelete(obs.id);
                            setConfirmDelete(null);
                          }}
                        >
                          ✓
                        </button>
                        <button
                          type="button"
                          className="text-button va-observations__action-btn"
                          onClick={() => setConfirmDelete(null)}
                        >
                          ✕
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="text-button va-observations__action-btn"
                        title="Delete"
                        onClick={() => setConfirmDelete(obs.id)}
                      >
                        🗑
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
