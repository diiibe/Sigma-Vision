import { useRef, useEffect, useState } from "react";
import { useCountingState } from "./useCountingState";
import type {
  ObservationDefinition,
  TrackRecord,
  TrafficCountingState,
} from "../data/types";

interface LiveFeedPanelProps {
  cameraId: string | null;
  cameraName: string;
  activeObservations: ObservationDefinition[];
  trafficState: TrafficCountingState | null | undefined;
}

export function LiveFeedPanel({
  cameraId,
  cameraName,
  activeObservations,
  trafficState,
}: LiveFeedPanelProps) {
  const hasActiveModel = activeObservations.some((o) => o.enabled);
  const enabledObs = activeObservations.filter((o) => o.enabled);
  const videoRef = useRef<HTMLVideoElement>(null);
  const prevHadModel = useRef(false);

  // Buffer on first task activation only
  useEffect(() => {
    if (hasActiveModel && !prevHadModel.current && cameraId) {
      const video = videoRef.current;
      if (video) {
        video.pause();
        const videoTime = video.currentTime || 0;
        fetch(`/api/live/reset-camera/${encodeURIComponent(cameraId)}?videoTime=${videoTime}`, {
          method: "POST",
        }).then(() => setTimeout(() => video.play(), 140))
          .catch(() => video.play());
      }
    }
    prevHadModel.current = hasActiveModel;
  }, [hasActiveModel, cameraId]);

  const countingState = useCountingState(cameraId, hasActiveModel);
  const tracks = countingState.tracks;
  const tc = hasActiveModel ? countingState.trafficCounting : trafficState ?? null;
  const events = tc?.countingEvents ?? [];
  const densitySnapshots = tc?.densitySnapshots ?? [];

  // Latest density count per zone
  const densityCounts = new Map<string, number>();
  for (const ds of densitySnapshots) {
    densityCounts.set(ds.zoneId, ds.vehicleCount);
  }

  if (!cameraId) {
    return (
      <section className="va-feed panel-section">
        <div className="section-heading va-feed__header">
          <div>
            <h2>Live Feed</h2>
            <p>Select an observation to inspect the aligned video stream.</p>
          </div>
        </div>
        <div className="va-feed__empty">Select an observation to view live feed</div>
      </section>
    );
  }

  return (
    <section className="va-feed panel-section">
      <div className="section-heading va-feed__header">
        <div>
          <h2>{cameraName}</h2>
          <p>{enabledObs.length} active task{enabledObs.length !== 1 ? "s" : ""}</p>
        </div>
        <span className="va-feed__obs-count">Camera feed</span>
      </div>

      <div className="va-feed__stack">
        {/* PRIMARY view: always has the real <video> */}
        {enabledObs.length >= 1 && (
          <TaskLabel obs={enabledObs[0]} events={events} densityCount={densityCounts.get(enabledObs[0].id)} />
        )}
        <div className="va-feed__frame-shell">
          <div className="va-feed__viewport">
            <video
              ref={videoRef}
              className="va-feed__frame"
              src={`/api/live/video/${encodeURIComponent(cameraId)}`}
              autoPlay muted loop playsInline
              aria-label={cameraName}
            />
            {enabledObs.length >= 1 && (
              <TaskSvgOverlay obs={enabledObs[0]} tracks={tracks} events={events} densityCount={densityCounts.get(enabledObs[0].id)} />
            )}
          </div>
        </div>

        {/* SECONDARY views: canvas clones for task 2, 3, ... */}
        {enabledObs.slice(1).map((obs) => (
          <ClonedTaskView
            key={obs.id}
            obs={obs}
            videoRef={videoRef}
            tracks={tracks}
            events={events}
            densityCount={densityCounts.get(obs.id)}
          />
        ))}
      </div>
    </section>
  );
}

/* ── Cloned canvas view for extra tasks ── */

function ClonedTaskView({
  obs,
  videoRef,
  tracks,
  events,
  densityCount,
}: {
  obs: ObservationDefinition;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  tracks: TrackRecord[];
  events: { lineId: string; trackId: string; eventType: "entry" | "exit" }[];
  densityCount?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    let raf = 0;
    function draw() {
      if (video!.videoWidth > 0 && canvas) {
        if (canvas.width !== video!.videoWidth) {
          canvas.width = video!.videoWidth;
          canvas.height = video!.videoHeight;
        }
        const ctx = canvas.getContext("2d");
        if (ctx) ctx.drawImage(video!, 0, 0);
      }
      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [videoRef]);

  return (
    <div className="va-feed__task-view">
      <TaskLabel obs={obs} events={events} densityCount={densityCount} />
      <div className="va-feed__frame-shell">
        <div className="va-feed__viewport">
          <canvas ref={canvasRef} className="va-feed__frame" />
          <TaskSvgOverlay obs={obs} tracks={tracks} events={events} densityCount={densityCount} />
        </div>
      </div>
    </div>
  );
}

/* ── SVG overlay for one task ── */

function TaskLabel({
  obs,
  events,
  densityCount,
}: {
  obs: ObservationDefinition;
  events: { lineId: string; trackId: string; eventType: "entry" | "exit" }[];
  densityCount?: number;
}) {
  if (obs.taskType === "density") {
    const color = "oklch(65% 0.15 270)";
    const cap = obs.capacityThreshold;
    const isOver = cap != null && (densityCount ?? 0) > cap;
    return (
      <div className="va-feed__task-label" style={{ color: isOver ? "oklch(68% 0.2 25)" : color }}>
        {obs.name} — Vehicles: <strong>{densityCount ?? 0}</strong>
        {cap ? ` / ${cap}` : ""}{isOver ? " ⚠" : ""}
      </div>
    );
  }
  const isEntry = obs.taskType === "entry";
  const color = isEntry ? "oklch(72% 0.19 145)" : "oklch(68% 0.2 25)";
  let count = 0;
  for (const e of events) {
    if (e.lineId === obs.id) count++;
  }
  return (
    <div className="va-feed__task-label" style={{ color }}>
      {obs.name} — {isEntry ? "IN" : "OUT"}: <strong>{count}</strong>
    </div>
  );
}

/** Track IDs that crossed recently — auto-expires after TTL */
function useRecentCrossings(
  events: { lineId: string; trackId: string }[],
  obsId: string,
  ttlMs = 3000,
): Set<string> {
  const [active, setActive] = useState<Set<string>>(new Set());
  const seenRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    for (const e of events) {
      if (e.lineId !== obsId) continue;
      if (seenRef.current.has(e.trackId)) continue;
      seenRef.current.add(e.trackId);
      setActive((prev) => new Set(prev).add(e.trackId));
      const timer = window.setTimeout(() => {
        setActive((prev) => {
          const next = new Set(prev);
          next.delete(e.trackId);
          return next;
        });
        timersRef.current.delete(e.trackId);
      }, ttlMs);
      timersRef.current.set(e.trackId, timer);
    }
  }, [events, obsId, ttlMs]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      timersRef.current.forEach((t) => window.clearTimeout(t));
    };
  }, []);

  return active;
}

function TaskSvgOverlay({
  obs,
  tracks,
  events,
  densityCount,
}: {
  obs: ObservationDefinition;
  tracks: TrackRecord[];
  events: { lineId: string; trackId: string; eventType: "entry" | "exit" }[];
  densityCount?: number;
}) {
  const W = 1000, H = 640;

  if (obs.taskType === "density") {
    // Density zone: polygon + vehicle count + bounding boxes
    const color = "oklch(65% 0.15 270)";
    const cap = obs.capacityThreshold;
    const isOver = cap != null && (densityCount ?? 0) > cap;
    const polyPoints = obs.points.map((p) => `${p[0] * W},${p[1] * H}`).join(" ");
    const cx = obs.points.reduce((s, p) => s + p[0], 0) / obs.points.length * W;
    const cy = obs.points.reduce((s, p) => s + p[1], 0) / obs.points.length * H;

    return (
      <svg className="va-feed__overlay" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {tracks.map((track) => {
          const [x1, y1, x2, y2] = track.bbox;
          return (
            <g key={track.trackId}>
              <rect
                x={x1 * W} y={y1 * H}
                width={(x2 - x1) * W} height={(y2 - y1) * H}
                fill="none" stroke="oklch(75% 0.12 60)" strokeWidth="1.5" rx="2"
              />
              <text x={x1 * W + 3} y={y1 * H - 4}
                fill="oklch(75% 0.12 60)" fontSize="10" fontWeight="600"
                fontFamily="IBM Plex Mono, monospace"
              >{track.className} {(track.confidence * 100).toFixed(0)}%</text>
            </g>
          );
        })}
        <polygon points={polyPoints}
          fill={isOver ? "oklch(68% 0.2 25 / 0.2)" : "oklch(65% 0.15 270 / 0.12)"}
          stroke={isOver ? "oklch(68% 0.2 25)" : "oklch(65% 0.15 270 / 0.6)"}
          strokeWidth="2" strokeDasharray={isOver ? "0" : "6 3"}
        />
        <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
          fill={isOver ? "oklch(68% 0.2 25)" : "oklch(85% 0.05 270)"}
          fontSize="28" fontWeight="700" fontFamily="IBM Plex Mono, monospace"
        >{densityCount ?? 0}{cap ? `/${cap}` : ""}</text>
      </svg>
    );
  }

  // Entry/exit: line + crossing highlights (flash for 3s after crossing)
  const isEntry = obs.taskType === "entry";
  const color = isEntry ? "oklch(72% 0.19 145)" : "oklch(68% 0.2 25)";
  const crossedTrackIds = useRecentCrossings(events, obs.id);

  const p1x = obs.points[0][0] * W, p1y = obs.points[0][1] * H;
  const p2x = obs.points[1][0] * W, p2y = obs.points[1][1] * H;
  const mx = (p1x + p2x) / 2, my = (p1y + p2y) / 2;
  const dx = p2x - p1x, dy = p2y - p1y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = -dy / len * 18, ny = dx / len * 18;

  return (
      <svg className="va-feed__overlay" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {tracks.map((track) => {
          const [x1, y1, x2, y2] = track.bbox;
          const crossed = crossedTrackIds.has(track.trackId);
          const boxColor = crossed ? color : "oklch(75% 0.12 60)";
          return (
            <g key={track.trackId}>
              <rect
                x={x1 * W} y={y1 * H}
                width={(x2 - x1) * W} height={(y2 - y1) * H}
                fill={crossed ? (isEntry ? "oklch(72% 0.19 145 / 0.15)" : "oklch(68% 0.2 25 / 0.15)") : "none"}
                stroke={boxColor} strokeWidth={crossed ? 2.5 : 1.5} rx="2"
              />
              <text x={x1 * W + 3} y={y1 * H - 4}
                fill={boxColor} fontSize="10" fontWeight="600"
                fontFamily="IBM Plex Mono, monospace"
              >{track.className} {(track.confidence * 100).toFixed(0)}%</text>
            </g>
          );
        })}

        <line x1={p1x} y1={p1y} x2={p2x} y2={p2y}
          stroke={color} strokeWidth="3" strokeLinecap="round" />
        <line x1={mx + nx} y1={my + ny} x2={mx} y2={my}
          stroke={color} strokeWidth="2" markerEnd={`url(#arr-${obs.id})`} />
        <text x={mx} y={my - 14}
          textAnchor="middle" fill={color}
          fontSize="13" fontWeight="600" fontFamily="Barlow Condensed, sans-serif"
        >{obs.name} {isEntry ? "\u2192 IN" : "\u2192 OUT"}</text>

        <defs>
          <marker id={`arr-${obs.id}`} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill={color} />
          </marker>
        </defs>
      </svg>
  );
}
