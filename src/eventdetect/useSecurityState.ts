import { useEffect, useState } from "react";

export interface TrackState {
  trackId: string;
  bbox: [number, number, number, number];
  className: string;
  confidence: number;
  centroid: [number, number];
  velocity: [number, number] | null;
  age: number;
}

export interface SecurityCameraState {
  tracks: TrackState[];
  frameIndex: number;
  currentSec: number;
  frameUrl: string | null;
}

const EMPTY: SecurityCameraState = { tracks: [], frameIndex: 0, currentSec: 0, frameUrl: null };

/**
 * Fast-poll hook for security camera state.
 * Matches useCountingState pattern: polls ~15ms, deduplicates by frameUrl.
 */
export function useSecurityState(
  cameraId: string | null,
  active: boolean,
): SecurityCameraState {
  const [state, setState] = useState<SecurityCameraState>(EMPTY);

  useEffect(() => {
    if (!active || !cameraId) {
      setState(EMPTY);
      return;
    }

    let running = true;
    let lastFrameUrl = "";

    async function poll() {
      const controller = new AbortController();
      while (running) {
        const t0 = performance.now();
        try {
          const res = await fetch(
            `/api/security/state/${encodeURIComponent(cameraId!)}`,
            { signal: controller.signal },
          );
          if (res.ok && running) {
            const data: SecurityCameraState = await res.json();
            if (data.frameUrl && data.frameUrl !== lastFrameUrl) {
              lastFrameUrl = data.frameUrl;
              setState(data);
            }
          }
        } catch {
          // ignore — timeout or abort
        }
        const elapsed = performance.now() - t0;
        const wait = Math.max(1, 30 - elapsed);
        await new Promise((r) => setTimeout(r, wait));
      }
      controller.abort();
    }

    poll();
    return () => {
      running = false;
    };
  }, [cameraId, active]);

  return state;
}
