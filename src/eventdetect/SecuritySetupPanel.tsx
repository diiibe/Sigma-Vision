import { useState, useCallback, useEffect } from "react";
import type { SecurityTask, SecurityZone, SecurityLine } from "./useEventDetection";

type DrawMode = "zone" | "line";

interface SecuritySetupPanelProps {
  cameraId: string;
  availableCameraIds: string[];
  onCameraChange(cameraId: string): void;
  onSave(task: SecurityTask): void;
}

export function SecuritySetupPanel({
  cameraId,
  availableCameraIds,
  onCameraChange,
  onSave,
}: SecuritySetupPanelProps) {
  const [tab, setTab] = useState<"global" | "spatial">("spatial");
  const [drawMode, setDrawMode] = useState<DrawMode>("zone");
  const [points, setPoints] = useState<[number, number][]>([]);
  const [name, setName] = useState("");
  const [dwellThreshold, setDwellThreshold] = useState(10);
  const [crowdThreshold, setCrowdThreshold] = useState(3);
  const [detectEntry, setDetectEntry] = useState(true);
  const [detectDwelling, setDetectDwelling] = useState(true);

  // Global toggles (no drawing needed)
  const [detectRunning, setDetectRunning] = useState(false);
  const [detectChasing, setDetectChasing] = useState(false);
  const [detectAltercation, setDetectAltercation] = useState(false);
  const [detectCrowd, setDetectCrowd] = useState(false);

  const [zones, setZones] = useState<SecurityZone[]>([]);
  const [lines, setLines] = useState<SecurityLine[]>([]);

  const [frameUrl, setFrameUrl] = useState<string | null>(null);

  // Frame screenshot for the editor canvas
  useEffect(() => {
    if (!cameraId) { setFrameUrl(null); return; }
    setFrameUrl(`/api/security/frame/${encodeURIComponent(cameraId)}`);
  }, [cameraId]);

  const maxPoints = drawMode === "zone" ? 20 : 2;
  const minPoints = drawMode === "zone" ? 3 : 2;
  const canAddShape = points.length >= minPoints;
  const hasAnySpatial = zones.length > 0 || lines.length > 0;
  const hasAnyGlobal = detectRunning || detectChasing || detectAltercation || detectCrowd;
  const canSave = (hasAnySpatial || hasAnyGlobal) && cameraId;

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (points.length >= maxPoints) return;
      const svg = e.currentTarget;
      const rect = svg.getBoundingClientRect();
      const x = Math.round(((e.clientX - rect.left) / rect.width) * 10000) / 10000;
      const y = Math.round(((e.clientY - rect.top) / rect.height) * 10000) / 10000;
      setPoints((prev) => [...prev, [x, y]]);
    },
    [points.length, maxPoints],
  );

  const handleAddShape = () => {
    if (!canAddShape) return;
    const id = `${drawMode}-${Date.now().toString(36)}`;
    if (drawMode === "zone") {
      setZones((prev) => [
        ...prev,
        {
          id,
          name: name || `Zone ${prev.length + 1}`,
          points: [...points],
          detectEntry,
          detectDwelling,
          dwellThresholdSec: dwellThreshold,
          detectRunning: false,
          detectChasing: false,
          detectAltercation: false,
          speedThreshold: 0.012,
          altercationProximity: 0.08,
          detectCrowdGathering: false,
          crowdThreshold: 3,
        },
      ]);
    } else {
      setLines((prev) => [
        ...prev,
        { id, name: name || `Line ${prev.length + 1}`, points: [...points], enabled: true },
      ]);
    }
    setPoints([]);
    setName("");
  };

  const handleSave = () => {
    // For global events, create a full-frame zone if needed
    const finalZones = [...zones];
    if (hasAnyGlobal) {
      finalZones.push({
        id: `global-${Date.now().toString(36)}`,
        name: name || "Full frame",
        points: [[0, 0], [1, 0], [1, 1], [0, 1]],
        detectEntry: false,
        detectDwelling: false,
        dwellThresholdSec: 10,
        detectRunning,
        detectChasing,
        detectAltercation,
        speedThreshold: 0.012,
        altercationProximity: 0.08,
        detectCrowdGathering: detectCrowd,
        crowdThreshold,
      });
    }

    onSave({
      id: "",
      cameraId,
      zones: finalZones,
      lines: [],  // lines removed — spatial uses zones only
      sampleRate: 4,
      enabled: true,
    });
    setZones([]);
    setLines([]);
    setPoints([]);
    setName("");
    setDetectRunning(false);
    setDetectChasing(false);
    setDetectAltercation(false);
    setDetectCrowd(false);
  };

  return (
    <div className="ed-setup panel-section panel-section--grow">
      <div className="section-heading">
        <div>
          <h2>Security Setup</h2>
          <p>Configure camera scope, spatial zones, and event detection without altering runtime behavior.</p>
        </div>
      </div>

      {/* Camera selector */}
      <label className="ed-setup__label">Camera</label>
      <select
        className="ed-setup__select"
        value={cameraId}
        onChange={(e) => {
          onCameraChange(e.target.value);
          setPoints([]); setZones([]); setLines([]);
        }}
      >
        <option value="">Select camera...</option>
        {availableCameraIds.map((id) => (
          <option key={id} value={id}>{id}</option>
        ))}
      </select>

      {cameraId && (
        <>
          {/* ── Tabs ── */}
          <div className="ed-setup__tabs">
            <button
              type="button"
              className={`action-button action-button--compact ed-setup__tab ${tab === "global" ? "is-active" : ""}`}
              onClick={() => setTab("global")}
            >
              Global
            </button>
            <button
              type="button"
              className={`action-button action-button--compact ed-setup__tab ${tab === "spatial" ? "is-active" : ""}`}
              onClick={() => setTab("spatial")}
            >
              Spatial
            </button>
          </div>

          {/* ── Global tab ── */}
          {tab === "global" && (
            <div className="ed-setup__tab-content">
              <label className="ed-setup__label">Name</label>
              <input type="text" className="ed-setup__input"
                value={name} onChange={(e) => setName(e.target.value)}
                placeholder="Task name" />

              <label className="ed-setup__label">Events</label>
              <div className="ed-setup__global-toggles">
                <button
                  type="button"
                  className={`action-button action-button--compact ed-setup__toggle-btn ${detectRunning ? "is-active" : ""}`}
                  onClick={() => setDetectRunning((v) => !v)}
                >
                  Running
                </button>
                <button
                  type="button"
                  className={`action-button action-button--compact ed-setup__toggle-btn ${detectChasing ? "is-active" : ""}`}
                  onClick={() => setDetectChasing((v) => !v)}
                >
                  Chasing
                </button>
                <button
                  type="button"
                  className={`action-button action-button--compact ed-setup__toggle-btn ${detectAltercation ? "is-active" : ""}`}
                  onClick={() => setDetectAltercation((v) => !v)}
                >
                  Altercation
                </button>
                <button
                  type="button"
                  className={`action-button action-button--compact ed-setup__toggle-btn ${detectCrowd ? "is-active" : ""}`}
                  onClick={() => setDetectCrowd((v) => !v)}
                >
                  Crowd
                </button>
              </div>
              {detectCrowd && (
                <label className="ed-setup__field">
                  <span className="ed-setup__field-label">Min people</span>
                  <input type="number" className="ed-setup__input ed-setup__input--small"
                    value={crowdThreshold} min={2} max={50}
                    onChange={(e) => setCrowdThreshold(Number(e.target.value))} />
                </label>
              )}
            </div>
          )}

          {/* ── Spatial tab ── */}
          {tab === "spatial" && (
            <div className="ed-setup__tab-content">
              <label className="ed-setup__label">Draw zone</label>

              {drawMode === "zone" && (
                <div className="ed-setup__zone-config">
                  <label className="ed-setup__check">
                    <input type="checkbox" checked={detectEntry} onChange={(e) => setDetectEntry(e.target.checked)} />
                    Detect entry
                  </label>
                  <label className="ed-setup__check">
                    <input type="checkbox" checked={detectDwelling} onChange={(e) => setDetectDwelling(e.target.checked)} />
                    Detect dwelling
                  </label>
                  {detectDwelling && (
                    <label className="ed-setup__field">
                      <span className="ed-setup__field-label">Dwell threshold (s)</span>
                      <input type="number" className="ed-setup__input ed-setup__input--small"
                        value={dwellThreshold} min={1} max={300}
                        onChange={(e) => setDwellThreshold(Number(e.target.value))} />
                    </label>
                  )}
                </div>
              )}

              {/* Canvas editor */}
              <label className="ed-setup__label">
            Draw {drawMode === "zone" ? "polygon" : "line"} ({points.length}/{minPoints}{drawMode === "zone" ? "+" : ""})
          </label>
          <div className="ed-setup__canvas-wrap">
            <svg
              className="ed-setup__canvas"
              viewBox="0 0 1000 640"
              onClick={handleCanvasClick}
              style={{ cursor: points.length < maxPoints ? "crosshair" : "default" }}
            >
              {frameUrl ? (
                <image href={frameUrl} x="0" y="0" width="1000" height="640" />
              ) : (
                <rect x="0" y="0" width="1000" height="640" fill="#1a1a2e" />
              )}

              {/* Added zones */}
              {zones.map((z) => (
                <g key={z.id}>
                  <polygon
                    points={z.points.map((p) => `${p[0] * 1000},${p[1] * 640}`).join(" ")}
                    fill="oklch(70% 0.2 25 / 0.12)"
                    stroke="oklch(70% 0.2 25 / 0.6)"
                    strokeWidth="2" strokeDasharray="6 3"
                  />
                  <text
                    x={z.points.reduce((s, p) => s + p[0], 0) / z.points.length * 1000}
                    y={z.points.reduce((s, p) => s + p[1], 0) / z.points.length * 640}
                    fill="oklch(70% 0.2 25)" fontSize="14"
                    fontFamily="IBM Plex Mono, monospace"
                    textAnchor="middle" dominantBaseline="middle"
                  >{z.name}</text>
                </g>
              ))}

              {/* Added lines */}
              {lines.map((l) => l.points.length >= 2 && (
                <g key={l.id}>
                  <line
                    x1={l.points[0][0] * 1000} y1={l.points[0][1] * 640}
                    x2={l.points[1][0] * 1000} y2={l.points[1][1] * 640}
                    stroke="oklch(68% 0.18 85)" strokeWidth="3" strokeLinecap="round"
                  />
                  <text
                    x={(l.points[0][0] + l.points[1][0]) / 2 * 1000}
                    y={(l.points[0][1] + l.points[1][1]) / 2 * 640 - 8}
                    fill="oklch(68% 0.18 85)" fontSize="12"
                    fontFamily="IBM Plex Mono, monospace" textAnchor="middle"
                  >{l.name}</text>
                </g>
              ))}

              {/* Drawing preview */}
              {drawMode === "zone" && points.length >= 3 && (
                <polygon
                  points={points.map((p) => `${p[0] * 1000},${p[1] * 640}`).join(" ")}
                  fill="oklch(72% 0.19 220 / 0.15)"
                  stroke="oklch(72% 0.19 220 / 0.7)"
                  strokeWidth="2" strokeDasharray="4 2"
                />
              )}
              {drawMode === "line" && points.length === 2 && (
                <line
                  x1={points[0][0] * 1000} y1={points[0][1] * 640}
                  x2={points[1][0] * 1000} y2={points[1][1] * 640}
                  stroke="oklch(72% 0.19 220)" strokeWidth="3" strokeLinecap="round"
                />
              )}
              {drawMode === "line" && points.length === 1 && (
                <circle cx={points[0][0] * 1000} cy={points[0][1] * 640}
                  r="8" fill="oklch(72% 0.19 220)" stroke="#111" strokeWidth="2" opacity="0.7" />
              )}
              {points.map((p, i) => (
                <circle key={i} cx={p[0] * 1000} cy={p[1] * 640} r="6"
                  fill="oklch(72% 0.19 220)" stroke="#111" strokeWidth="2" />
              ))}
            </svg>

            <div className="ed-setup__canvas-actions">
              <button type="button" className="ed-setup__small-btn"
                onClick={() => setPoints((p) => p.slice(0, -1))} disabled={points.length === 0}>
                Undo
              </button>
              <button type="button" className="ed-setup__small-btn"
                onClick={() => setPoints([])} disabled={points.length === 0}>
                Clear
              </button>
              <button type="button" className="ed-setup__small-btn ed-setup__small-btn--primary"
                onClick={handleAddShape} disabled={!canAddShape}>
                Add {drawMode}
              </button>
            </div>
          </div>

          {/* Name field */}
          <label className="ed-setup__label">Name</label>
          <input type="text" className="ed-setup__input"
            value={name} onChange={(e) => setName(e.target.value)}
            placeholder={drawMode === "zone" ? "Zone name" : "Line name"} />

              {/* Added shapes */}
              {zones.length > 0 && (
                <div className="ed-setup__shapes">
                  <label className="ed-setup__label">Zones ({zones.length})</label>
                  {zones.map((z) => (
                    <div key={z.id} className="ed-setup__shape-row">
                      <span>{z.name}</span>
                      <button type="button" className="ed-setup__remove"
                        onClick={() => setZones((p) => p.filter((x) => x.id !== z.id))}>x</button>
                    </div>
                  ))}
                </div>
              )}
              {lines.length > 0 && (
                <div className="ed-setup__shapes">
                  <label className="ed-setup__label">Lines ({lines.length})</label>
                  {lines.map((l) => (
                    <div key={l.id} className="ed-setup__shape-row">
                      <span>{l.name}</span>
                      <button type="button" className="ed-setup__remove"
                        onClick={() => setLines((p) => p.filter((x) => x.id !== l.id))}>x</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Save */}
          <button type="button" className="ed-setup__btn ed-setup__btn--save"
            disabled={!canSave} onClick={handleSave}>
            Save & Start Monitoring
          </button>
        </>
      )}
    </div>
  );
}
