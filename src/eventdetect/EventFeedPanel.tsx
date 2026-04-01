import { useRef, useEffect, useMemo, useState } from "react";
import type { SecurityCameraState, TrackState } from "./useSecurityState";
import type { SecurityTask, SecurityEvent } from "./useEventDetection";

interface EventFeedPanelProps {
  cameraId: string | null;
  cameraState: SecurityCameraState;
  activeTask: SecurityTask | null;
  events: SecurityEvent[];
  drawingPoints: [number, number][];
  drawMode: "zone" | "line" | null;
  onCanvasClick?(e: React.MouseEvent<SVGSVGElement>): void;
}

const W = 1000;
const H = 640;


// ── Recent event tracking (flash bboxes for 3s like counting) ──

/** Maps trackId → event color for tracks involved in recent events for THIS task only. */
function useRecentEventTracks(
  events: SecurityEvent[],
  cameraId: string | null,
  task: SecurityTask | null,
): Map<string, string> {
  const [map, setMap] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    if (!task) { setMap(new Map()); return; }

    // Build set of event types this specific task monitors
    const taskTypes = new Set<string>();
    for (const z of task.zones) {
      if (z.detectEntry) taskTypes.add("zone_entry");
      if (z.detectDwelling) taskTypes.add("dwelling");
      if (z.detectRunning) taskTypes.add("running");
      if (z.detectChasing) taskTypes.add("chasing");
      if (z.detectAltercation) taskTypes.add("altercation");
      if (z.detectCrowdGathering) taskTypes.add("crowd_gathering");
    }

    const now = Date.now();
    const recent = events.filter((e) => {
      if (e.cameraId !== cameraId) return false;
      if (!taskTypes.has(e.eventType)) return false;
      return (now - new Date(e.timestamp).getTime()) < 3000;
    });

    const m = new Map<string, string>();
    for (const e of recent) {
      const color = EVENT_BADGE_COLORS[e.eventType] ?? "oklch(90% 0.2 25)";
      for (const tid of e.trackIds) m.set(tid, color);
    }
    setMap(m);

    if (recent.length > 0) {
      const timer = setTimeout(() => setMap(new Map()), 3000);
      return () => clearTimeout(timer);
    }
  }, [events, cameraId, task]);

  return map;
}

// ── Colors ──

const TRACK_COLORS: Record<string, string> = {
  person: "oklch(70% 0.2 25)",
  car: "oklch(72% 0.19 220)",
  truck: "oklch(65% 0.15 270)",
  bus: "oklch(68% 0.18 85)",
  motorcycle: "oklch(72% 0.19 160)",
  bicycle: "oklch(72% 0.19 195)",
};

const EVENT_BADGE_COLORS: Record<string, string> = {
  running: "oklch(75% 0.18 230)",
  chasing: "oklch(75% 0.18 230)",
  altercation: "oklch(80% 0.2 230)",
  zone_entry: "oklch(75% 0.18 230)",
  dwelling: "oklch(75% 0.18 230)",
  line_crossing: "oklch(75% 0.18 230)",
  crowd_gathering: "oklch(75% 0.18 230)",
};

const EVENT_LABELS: Record<string, string> = {
  running: "RUNNING",
  chasing: "CHASING",
  altercation: "ALTERCATION",
  zone_entry: "ENTRY",
  dwelling: "DWELLING",
  line_crossing: "CROSSED",
  crowd_gathering: "CROWD",
};

// ── TaskLabel (like counting's TaskLabel) ──

function TaskLabel({ task }: { task: SecurityTask }) {
  const zoneCount = task.zones.length;
  const lineCount = task.lines.length;
  const parts: string[] = [];
  if (zoneCount > 0) parts.push(`${zoneCount} zone${zoneCount > 1 ? "s" : ""}`);
  if (lineCount > 0) parts.push(`${lineCount} line${lineCount > 1 ? "s" : ""}`);

  return (
    <div className="ed-feed__task-label">
      <span>{task.cameraId}</span>
      <span className="ed-feed__task-meta">{parts.join(" · ")}</span>
    </div>
  );
}

// ── Main Component ──

export function EventFeedPanel({
  cameraId,
  cameraState,
  activeTask,
  events,
  drawingPoints,
  drawMode,
  onCanvasClick,
}: EventFeedPanelProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const prevHadTask = useRef(false);
  const hasTask = activeTask !== null;
  const recentTracks = useRecentEventTracks(events, cameraId, activeTask);

  // Load video when camera changes
  const cameraStateRef = useRef(cameraState);
  cameraStateRef.current = cameraState;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !cameraId) return;
    const url = `/api/security/video/${cameraId}`;
    if (!video.src || !video.src.endsWith(url)) {
      video.src = url;
    }

    // On load: seek to backend position, then send reset so model syncs to video
    function onLoaded() {
      if (!video.duration || !Number.isFinite(video.duration)) return;
      const sec = cameraStateRef.current.currentSec;
      if (sec > 0) {
        video.currentTime = sec % video.duration;
      }
      // After seeking, tell backend where we are
      if (hasTask) {
        const videoTime = video.currentTime || 0;
        fetch(`/api/security/reset/${encodeURIComponent(cameraId!)}?videoTime=${videoTime}`, {
          method: "POST",
        }).catch(() => {});
      }
    }
    video.addEventListener("loadedmetadata", onLoaded);
    return () => video.removeEventListener("loadedmetadata", onLoaded);
  }, [cameraId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Buffer sync on first task activation (when video is ALREADY loaded)
  useEffect(() => {
    if (hasTask && !prevHadTask.current && cameraId) {
      const video = videoRef.current;
      if (video && video.readyState >= 2) {
        // Video already loaded — pause, reset, resume
        video.pause();
        const videoTime = video.currentTime || 0;
        fetch(`/api/security/reset/${encodeURIComponent(cameraId)}?videoTime=${videoTime}`, {
          method: "POST",
        })
          .then(() => setTimeout(() => video.play(), 300))
          .catch(() => video.play());
      }
      // If video not loaded yet, loadedmetadata handler will do the reset
    }
    prevHadTask.current = hasTask;
  }, [hasTask, cameraId]);

  if (!cameraId) {
    return (
      <section className="ed-feed panel-section">
        <div className="section-heading ed-feed__header">
          <div>
            <h2>Live Feed</h2>
            <p>Select a camera to inspect spatial overlays and event highlights.</p>
          </div>
        </div>
        <div className="ed-feed__empty">Select a camera to start</div>
      </section>
    );
  }

  return (
    <section className="ed-feed panel-section">
      <div className="section-heading ed-feed__header">
        <div>
          <h2>{cameraId}</h2>
          <p>{activeTask ? "1 active task" : "0 active tasks"}</p>
        </div>
        <span className="ed-feed__eyebrow">Camera feed</span>
      </div>

      {activeTask && <TaskLabel task={activeTask} />}

      <div className="ed-feed__frame-shell">
        <div className="ed-feed__viewport">
          <video ref={videoRef} className="ed-feed__frame" autoPlay muted loop playsInline />
          <svg
            className="ed-feed__overlay"
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            onClick={onCanvasClick}
            style={{ cursor: drawMode ? "crosshair" : "default" }}
          >
          {/* Security zones — red dashed polygon (skip full-frame global zones) */}
          {activeTask?.zones.filter((z) => z.name !== "Full frame").map((z) => (
            <g key={z.id}>
              <polygon
                points={z.points.map(([x, y]) => `${x * W},${y * H}`).join(" ")}
                fill="oklch(70% 0.2 25 / 0.08)"
                stroke="oklch(70% 0.2 25)"
                strokeWidth={1.5}
                strokeDasharray="6 3"
              />
              <text
                x={z.points.reduce((s, p) => s + p[0], 0) / z.points.length * W}
                y={z.points.reduce((s, p) => s + p[1], 0) / z.points.length * H}
                fill="oklch(70% 0.2 25)"
                fontSize={13}
                fontFamily="IBM Plex Mono, monospace"
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {z.name}
              </text>
            </g>
          ))}

          {/* Security lines — orange */}
          {activeTask?.lines.map((l) =>
            l.points.length >= 2 ? (
              <g key={l.id}>
                <line
                  x1={l.points[0][0] * W} y1={l.points[0][1] * H}
                  x2={l.points[1][0] * W} y2={l.points[1][1] * H}
                  stroke="oklch(68% 0.18 85)"
                  strokeWidth={2.5}
                />
                <text
                  x={(l.points[0][0] + l.points[1][0]) / 2 * W}
                  y={(l.points[0][1] + l.points[1][1]) / 2 * H - 8}
                  fill="oklch(68% 0.18 85)"
                  fontSize={12}
                  fontFamily="IBM Plex Mono, monospace"
                  textAnchor="middle"
                >
                  {l.name}
                </text>
              </g>
            ) : null,
          )}

          {/* Track bounding boxes */}
          {cameraState.tracks.map((t) => {
            const eventColor = recentTracks.get(t.trackId);
            const isHighlighted = !!eventColor;
            const color = eventColor ?? (TRACK_COLORS[t.className] ?? "oklch(70% 0.05 248)");
            return (
              <g key={t.trackId}>
                <rect
                  x={t.bbox[0] * W} y={t.bbox[1] * H}
                  width={(t.bbox[2] - t.bbox[0]) * W}
                  height={(t.bbox[3] - t.bbox[1]) * H}
                  fill="none"
                  stroke={color}
                  strokeWidth={isHighlighted ? 2.5 : 1.2}
                />
                <text
                  x={t.bbox[0] * W + 3}
                  y={t.bbox[1] * H - 4}
                  fill={color}
                  fontSize={10}
                  fontFamily="IBM Plex Mono, monospace"
                >
                  {t.className} {(t.confidence * 100).toFixed(0)}%
                </text>
              </g>
            );
          })}

          {/* Event badges near triggered tracks — filtered to this task's event types */}
          {events
            .filter((ev) => ev.cameraId === cameraId && recentTracks.has(ev.trackIds[0]))
            .map((ev) => {
              const track = cameraState.tracks.find((t) => ev.trackIds.includes(t.trackId));
              if (!track) return null;
              const label = EVENT_LABELS[ev.eventType] ?? ev.eventType;
              const color = EVENT_BADGE_COLORS[ev.eventType] ?? "oklch(70% 0.1 248)";
              return (
                <g key={ev.id}>
                  <rect
                    x={track.bbox[2] * W + 3}
                    y={track.bbox[1] * H}
                    width={label.length * 7.5 + 8}
                    height={16}
                    rx={3}
                    fill={color}
                  />
                  <text
                    x={track.bbox[2] * W + 7}
                    y={track.bbox[1] * H + 12}
                    fill="#fff"
                    fontSize={10}
                    fontFamily="IBM Plex Mono, monospace"
                    fontWeight="bold"
                  >
                    {label}
                  </text>
                </g>
              );
            })}

          {/* Drawing preview */}
          {drawingPoints.length > 0 && drawMode === "zone" && (
            <polygon
              points={drawingPoints.map(([x, y]) => `${x * W},${y * H}`).join(" ")}
              fill="oklch(72% 0.19 220 / 0.12)"
              stroke="oklch(72% 0.19 220)"
              strokeWidth={2}
              strokeDasharray="4 2"
            />
          )}
          {drawingPoints.length >= 2 && drawMode === "line" && (
            <line
              x1={drawingPoints[0][0] * W} y1={drawingPoints[0][1] * H}
              x2={drawingPoints[1][0] * W} y2={drawingPoints[1][1] * H}
              stroke="oklch(72% 0.19 220)"
              strokeWidth={3}
              strokeDasharray="4 2"
            />
          )}
          {drawingPoints.map(([x, y], i) => (
            <circle key={i} cx={x * W} cy={y * H} r={5} fill="oklch(72% 0.19 220)" />
          ))}
          </svg>
        </div>
      </div>
    </section>
  );
}
