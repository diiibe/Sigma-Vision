import { useState, useCallback } from "react";
import type {
  ObservationDefinition,
  PolygonPoint,
  LiveStateSnapshot,
  SpatialZoneDefinition,
} from "../data/types";

type TaskType = "entry" | "exit" | "density";
type AssocLevel = "facility" | "level" | "zone";

interface SetupPanelProps {
  snapshot: LiveStateSnapshot | null;
  availableCameraIds: string[];
  editingObservation?: ObservationDefinition | null;
  onSave(obs: ObservationDefinition): void;
  onCancel?(): void;
  onCameraChange?(cameraId: string): void;
}

export function SetupPanel({
  snapshot,
  availableCameraIds,
  editingObservation,
  onSave,
  onCancel,
  onCameraChange,
}: SetupPanelProps) {
  const cameras = snapshot?.cameras ?? [];
  const levels = snapshot?.levels ?? [];
  const allZones: SpatialZoneDefinition[] = snapshot?.config?.active?.zones ?? [];

  // Merge configured cameras with all discovered cameras (use only those in availableCameraIds)
  const allCameraIds = Array.from(
    new Set([...availableCameraIds, ...cameras.map((c) => c.id).filter((id) => availableCameraIds.includes(id))]),
  );

  // Derive initial state from editing observation
  const initAssocLevel: AssocLevel = editingObservation?.associationType ?? "facility";
  const initLevelId =
    initAssocLevel === "level"
      ? (editingObservation?.associationId ?? "")
      : initAssocLevel === "zone"
        ? (allZones.find((z) => z.id === editingObservation?.associationId)?.levelId ?? "")
        : "";
  const initZoneId = initAssocLevel === "zone" ? (editingObservation?.associationId ?? "") : "";

  const [cameraId, setCameraId] = useState(editingObservation?.cameraId ?? allCameraIds[0] ?? "");
  const [taskType, setTaskType] = useState<TaskType>(editingObservation?.taskType ?? "entry");
  const [assocLevel, setAssocLevel] = useState<AssocLevel>(initAssocLevel);
  const [selectedLevelId, setSelectedLevelId] = useState(initLevelId);
  const [selectedZoneId, setSelectedZoneId] = useState(initZoneId);
  const [name, setName] = useState(editingObservation?.name ?? "");
  const [capacity, setCapacity] = useState(editingObservation?.capacityThreshold ?? 4);
  const [points, setPoints] = useState<PolygonPoint[]>(editingObservation?.points ?? []);

  const isEditing = !!editingObservation;
  const camera = cameras.find((c) => c.id === cameraId);
  const frameUrl = camera?.frameUrl ?? null;

  // Zones filtered by selected level
  const zonesForLevel = selectedLevelId
    ? allZones.filter((z) => z.levelId === selectedLevelId)
    : [];

  // Build the final association from the hierarchical selection
  const resolvedAssocType: AssocLevel =
    assocLevel === "zone" && selectedZoneId ? "zone"
    : assocLevel !== "facility" && selectedLevelId ? "level"
    : "facility";
  const resolvedAssocId: string | null =
    resolvedAssocType === "zone" ? selectedZoneId
    : resolvedAssocType === "level" ? selectedLevelId
    : null;

  const autoName = `${taskType}-${cameraId.slice(0, 8)}${resolvedAssocId ? `-${resolvedAssocId.slice(0, 12)}` : ""}`;
  const displayName = name || autoName;

  const maxPoints = taskType === "density" ? 20 : 2;
  const minPoints = taskType === "density" ? 3 : 2;
  const canSave = points.length >= minPoints && cameraId;

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (points.length >= maxPoints) return;
      const svg = e.currentTarget;
      const rect = svg.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      setPoints((prev) => [...prev, [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000]]);
    },
    [points.length, maxPoints],
  );

  const handleUndo = () => setPoints((prev) => prev.slice(0, -1));
  const handleClear = () => setPoints([]);

  const handleSave = () => {
    const now = new Date().toISOString();
    const obs: ObservationDefinition = {
      id: editingObservation?.id ?? `obs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: displayName,
      cameraId,
      taskType,
      points,
      associationType: resolvedAssocType,
      associationId: resolvedAssocId,
      capacityThreshold: taskType === "density" ? capacity : null,
      enabled: editingObservation?.enabled ?? false,
      createdAt: editingObservation?.createdAt ?? now,
      updatedAt: now,
    };
    onSave(obs);
    if (!isEditing) {
      setPoints([]);
      setName("");
    }
  };

  return (
    <div className="va-setup panel-section panel-section--grow">
      <div className="section-heading">
        <div>
          <h2>{isEditing ? "Edit Observation" : "New Observation"}</h2>
          <p>Configure camera, geometry, and association scope without changing runtime logic.</p>
        </div>
      </div>

      {/* Camera selector */}
      <label className="va-setup__label">Camera</label>
      <select
        className="va-setup__select"
        value={cameraId}
        onChange={(e) => {
          setCameraId(e.target.value);
          setPoints([]);
          onCameraChange?.(e.target.value);
        }}
        disabled={isEditing}
      >
        {allCameraIds.map((id) => {
          const cam = cameras.find((c) => c.id === id);
          return (
            <option key={id} value={id}>
              {cam ? cam.name : id}
            </option>
          );
        })}
      </select>

      {/* Task type buttons */}
      <label className="va-setup__label">Task Type</label>
      <div className="va-setup__task-buttons">
        {(["entry", "exit", "density"] as TaskType[]).map((t) => (
          <button
            key={t}
            type="button"
            className={`va-setup__task-btn va-setup__task-btn--${t} ${taskType === t ? "is-active" : ""}`}
            onClick={() => {
              setTaskType(t);
              setPoints([]);
            }}
          >
            {t === "entry" ? "Entry" : t === "exit" ? "Exit" : "Density Zone"}
          </button>
        ))}
      </div>

      {/* Hierarchical association: General → Floor → Floor + Zone */}
      <label className="va-setup__label">Associate To</label>
      <div className="va-setup__assoc-stack">
        {/* Step 1: scope */}
        <div className="va-setup__assoc-buttons">
          {(["facility", "level", "zone"] as AssocLevel[]).map((lvl) => (
            <button
              key={lvl}
              type="button"
              className={`va-setup__assoc-btn ${assocLevel === lvl ? "is-active" : ""}`}
              onClick={() => {
                setAssocLevel(lvl);
                if (lvl === "facility") {
                  setSelectedLevelId("");
                  setSelectedZoneId("");
                }
                if (lvl === "level") {
                  setSelectedZoneId("");
                }
              }}
            >
              {lvl === "facility" ? "General" : lvl === "level" ? "Floor" : "Floor + Zone"}
            </button>
          ))}
        </div>

        {/* Step 2: floor selector (shown for level and zone) */}
        {assocLevel !== "facility" && (
          <select
            className="va-setup__select"
            value={selectedLevelId}
            onChange={(e) => {
              setSelectedLevelId(e.target.value);
              setSelectedZoneId("");
            }}
          >
            <option value="">— select floor —</option>
            {levels.map((lv) => (
              <option key={lv.id} value={lv.id}>
                {lv.name}
              </option>
            ))}
          </select>
        )}

        {/* Step 3: zone selector (only for zone, requires floor) */}
        {assocLevel === "zone" && selectedLevelId && (
          <select
            className="va-setup__select"
            value={selectedZoneId}
            onChange={(e) => setSelectedZoneId(e.target.value)}
          >
            <option value="">— select zone —</option>
            {zonesForLevel.map((z) => (
              <option key={z.id} value={z.id}>
                {z.label || z.id}
              </option>
            ))}
            {zonesForLevel.length === 0 && (
              <option value="" disabled>No zones on this floor</option>
            )}
          </select>
        )}
      </div>

      {/* Capacity (density only) */}
      {taskType === "density" && (
        <>
          <label className="va-setup__label">Capacity Threshold</label>
          <input
            type="number"
            className="va-setup__input"
            value={capacity}
            min={1}
            onChange={(e) => setCapacity(Math.max(1, parseInt(e.target.value) || 1))}
          />
        </>
      )}

      {/* Canvas editor */}
      <label className="va-setup__label">
        Draw {taskType === "density" ? "polygon" : "line"} ({points.length}/{minPoints}
        {taskType === "density" ? "+" : ""} points)
      </label>
      <div className="va-setup__canvas-wrap">
        <svg
          className="va-setup__canvas"
          viewBox="0 0 1000 640"
          onClick={handleCanvasClick}
          style={{ cursor: points.length < maxPoints ? "crosshair" : "default" }}
        >
          {frameUrl ? (
            <image href={frameUrl} x="0" y="0" width="1000" height="640" />
          ) : (
            <rect x="0" y="0" width="1000" height="640" fill="#1a1a2e" />
          )}

          {taskType === "density" && points.length >= 3 && (
            <polygon
              points={points.map((p) => `${p[0] * 1000},${p[1] * 640}`).join(" ")}
              fill="oklch(65% 0.15 270 / 0.18)"
              stroke="oklch(65% 0.15 270 / 0.7)"
              strokeWidth="2"
              strokeDasharray="6 3"
            />
          )}
          {taskType !== "density" && points.length === 2 && (
            <line
              x1={points[0][0] * 1000}
              y1={points[0][1] * 640}
              x2={points[1][0] * 1000}
              y2={points[1][1] * 640}
              stroke={taskType === "entry" ? "oklch(72% 0.19 145)" : "oklch(68% 0.2 25)"}
              strokeWidth="3"
              strokeLinecap="round"
            />
          )}
          {taskType !== "density" && points.length === 1 && (
            <circle
              cx={points[0][0] * 1000}
              cy={points[0][1] * 640}
              r="8"
              fill={taskType === "entry" ? "oklch(72% 0.19 145)" : "oklch(68% 0.2 25)"}
              stroke="#111"
              strokeWidth="2"
              opacity="0.7"
            />
          )}

          {points.map((p, i) => (
            <circle
              key={i}
              cx={p[0] * 1000}
              cy={p[1] * 640}
              r="6"
              fill={
                taskType === "entry"
                  ? "oklch(72% 0.19 145)"
                  : taskType === "exit"
                    ? "oklch(68% 0.2 25)"
                    : "oklch(65% 0.15 270)"
              }
              stroke="#111"
              strokeWidth="2"
            />
          ))}
        </svg>
        <div className="va-setup__canvas-actions">
          <button type="button" className="va-setup__small-btn" onClick={handleUndo} disabled={points.length === 0}>
            Undo
          </button>
          <button type="button" className="va-setup__small-btn" onClick={handleClear} disabled={points.length === 0}>
            Clear
          </button>
        </div>
      </div>

      {/* Name */}
      <label className="va-setup__label">Name</label>
      <input
        type="text"
        className="va-setup__input"
        value={name}
        placeholder={autoName}
        onChange={(e) => setName(e.target.value)}
      />

      {/* Actions */}
      <div className="va-setup__actions">
        <button
          type="button"
          className="va-setup__save-btn"
          disabled={!canSave}
          onClick={handleSave}
        >
          {isEditing ? "Update" : "Save"}
        </button>
        {isEditing && onCancel && (
          <button type="button" className="va-setup__cancel-btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
