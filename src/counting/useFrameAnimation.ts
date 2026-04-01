import { useEffect, useRef, useState } from "react";

interface FrameAnimationOptions {
  cameraId: string | null;
  frameCount: number | null;
  fps: number | null;
  apiBase?: string;
}

/**
 * Animates through video frames locally at the video's native FPS.
 * Constructs frame URLs directly using the known pattern:
 *   /api/live/frame/{cameraId}-video-{index}?cameraId={cameraId}
 *
 * The backend serves individual frame JPEGs — this hook just cycles
 * through them with a local timer, independent of the snapshot poll rate.
 */
export function useFrameAnimation({
  cameraId,
  frameCount,
  fps,
  apiBase = "/api",
}: FrameAnimationOptions): string | null {
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const indexRef = useRef(0);

  useEffect(() => {
    if (!cameraId || !frameCount || frameCount <= 0 || !fps || fps <= 0) {
      setFrameUrl(null);
      return;
    }

    indexRef.current = 0;
    const intervalMs = 1000 / fps;

    const buildUrl = (index: number) => {
      const frameId = `${cameraId}-video-${String(index + 1).padStart(6, "0")}`;
      return `${apiBase}/live/frame/${encodeURIComponent(frameId)}?cameraId=${encodeURIComponent(cameraId)}`;
    };

    setFrameUrl(buildUrl(0));

    const timer = window.setInterval(() => {
      indexRef.current = (indexRef.current + 1) % frameCount;
      setFrameUrl(buildUrl(indexRef.current));
    }, intervalMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [cameraId, frameCount, fps, apiBase]);

  return frameUrl;
}
