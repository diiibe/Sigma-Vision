import { useEffect, useRef, useState } from "react";
import type { TrackRecord, TrafficCountingState } from "../data/types";

export interface CountingSession {
  id: string;
  observation_id: string;
  observation_name: string;
  camera_id: string;
  task_type: string;
  started_at: string;
  stopped_at: string | null;
  entries: number;
  exits: number;
  status: "active" | "completed";
}

export interface CountingState {
  tracks: TrackRecord[];
  trafficCounting: TrafficCountingState | null;
  frameUrl: string | null;
  sessions: CountingSession[];
}

const EMPTY: CountingState = { tracks: [], trafficCounting: null, frameUrl: null, sessions: [] };

/**
 * Polls the lightweight counting-state endpoint as fast as the model produces frames.
 * Returns the frame URL + tracks for synchronized display.
 */
export function useCountingState(
  cameraId: string | null,
  active: boolean,
): CountingState {
  const [state, setState] = useState<CountingState>(EMPTY);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!active || !cameraId) {
      setState(EMPTY);
      return;
    }

    let running = true;
    let lastFrameUrl = "";

    async function poll() {
      while (running) {
        const t0 = performance.now();
        try {
          abortRef.current = new AbortController();
          const res = await fetch(
            `/api/live/counting-state/${encodeURIComponent(cameraId!)}`,
            { signal: abortRef.current.signal },
          );
          if (res.ok && running) {
            const data = await res.json();
            // Only update state when we have a new frame (avoid stale re-renders)
            if (data.frameUrl && data.frameUrl !== lastFrameUrl) {
              lastFrameUrl = data.frameUrl;
              setState({
                tracks: data.tracks ?? [],
                trafficCounting: data.trafficCounting ?? null,
                frameUrl: data.frameUrl,
                sessions: data.sessions ?? [],
              });
            }
          }
        } catch {
          // ignore
        }
        if (!running) break;
        // Poll fast — skip stale frames, only render new ones
        const elapsed = performance.now() - t0;
        await new Promise((r) => setTimeout(r, Math.max(1, 15 - elapsed)));
      }
    }

    poll();
    return () => { running = false; abortRef.current?.abort(); };
  }, [cameraId, active]);

  return state;
}
