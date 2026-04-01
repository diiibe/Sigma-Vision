#!/usr/bin/env python3
"""End-to-end test of the counting pipeline on entry video.

Processes all frames through: YOLO detect → ByteTrack → LineCrossing + Density.
Equivalent to what counting_visdrone.ipynb does, using the runtime classes.

Usage:
    python -m scripts.test_counting_pipeline
    python -m scripts.test_counting_pipeline --max-frames 200 --sample-fps 5
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

from backend.vision.detector import YoloDetector
from backend.vision.tracker import ByteTrackAdapter
from backend.runtime.counting_engine import LineCrossingEngine, DensityEngine
from backend.models import CountingLineDefinition, DensityZoneDefinition


# ── Default test geometry (entry camera) ──────────────────────────────
# These are approximate lines for the entry.mp4 video.
# Adjust after viewing the first frame if needed.
TEST_ENTRY_LINE = CountingLineDefinition(
    id="test-entry-line",
    label="Entry Line",
    cameraId="entry",
    kind="entry",
    points=[(0.35, 0.55), (0.75, 0.55)],
    enabled=True,
)

TEST_EXIT_LINE = CountingLineDefinition(
    id="test-exit-line",
    label="Exit Line",
    cameraId="entry",
    kind="exit",
    points=[(0.35, 0.45), (0.75, 0.45)],
    enabled=True,
)

TEST_DENSITY_ZONE = DensityZoneDefinition(
    id="test-density-zone",
    label="Test Zone",
    cameraId="entry",
    imagePolygon=[(0.2, 0.3), (0.9, 0.3), (0.9, 0.8), (0.2, 0.8)],
    enabled=True,
    capacityThreshold=10,
)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--camera", default="entry")
    parser.add_argument("--max-frames", type=int, default=0, help="0 = all frames")
    parser.add_argument("--sample-fps", type=float, default=0, help="0 = every frame")
    parser.add_argument("--no-lines", action="store_true", help="Skip line crossing")
    parser.add_argument("--no-density", action="store_true", help="Skip density zones")
    args = parser.parse_args()

    camera_id = args.camera
    cache_dir = Path(f"demo/videos/{camera_id}")
    frame_dirs = sorted(cache_dir.iterdir()) if cache_dir.exists() else []
    if not frame_dirs:
        print(f"No cached frames for camera '{camera_id}' in {cache_dir}")
        return

    frames = sorted(frame_dirs[0].glob("frame_*.jpg"))
    total_frames = len(frames)
    print(f"Camera: {camera_id}  |  Total frames: {total_frames}")

    # Sample if requested
    if args.sample_fps > 0:
        # Assume native ~24fps, take every Nth frame
        step = max(1, int(24.0 / args.sample_fps))
        frames = frames[::step]
        print(f"Sampling at ~{args.sample_fps}fps (step={step}) → {len(frames)} frames")

    if args.max_frames > 0:
        frames = frames[: args.max_frames]
        print(f"Limited to {len(frames)} frames")

    # Init pipeline
    print("\nLoading YOLO detector...")
    detector = YoloDetector()
    if not detector._ensure_model():
        print(f"FAILED: {detector.error_message}")
        return
    print("Model loaded OK")

    tracker = ByteTrackAdapter(track_buffer=30)
    line_engine = LineCrossingEngine(cooldown_frames=5, min_track_age=3, trail_len=8)
    density_engine = DensityEngine(min_track_age=2, smooth_window=3)

    counting_lines = [] if args.no_lines else [TEST_ENTRY_LINE, TEST_EXIT_LINE]
    density_zones = [] if args.no_density else [TEST_DENSITY_ZONE]

    # Process frames
    total_entries = 0
    total_exits = 0
    total_det_time = 0.0
    total_trk_time = 0.0
    total_cnt_time = 0.0

    for i, frame_path in enumerate(frames):
        frame_id = f"{camera_id}-video-{frame_path.stem.split('_')[1]}"
        timestamp = f"2026-01-01T00:00:{i:02d}Z"

        # Detect
        t0 = time.perf_counter()
        detections = detector.detect(frame_path, frame_id, timestamp)
        det_ms = (time.perf_counter() - t0) * 1000
        total_det_time += det_ms

        # Track
        t0 = time.perf_counter()
        tracks = tracker.update(detections, frame_id, timestamp, 1920, 1080)
        trk_ms = (time.perf_counter() - t0) * 1000
        total_trk_time += trk_ms

        # Count
        t0 = time.perf_counter()
        events = line_engine.update(camera_id, counting_lines, tracks, timestamp)
        density = density_engine.update(camera_id, density_zones, tracks, timestamp)
        cnt_ms = (time.perf_counter() - t0) * 1000
        total_cnt_time += cnt_ms

        for e in events:
            if e.eventType == "entry":
                total_entries += 1
            else:
                total_exits += 1

        # Progress
        if (i + 1) % 50 == 0 or i == len(frames) - 1:
            avg_det = total_det_time / (i + 1)
            avg_trk = total_trk_time / (i + 1)
            max_fps = 1000 / (avg_det + avg_trk) if (avg_det + avg_trk) > 0 else 0
            density_str = ""
            if density:
                density_str = f"  density={density[0].vehicleCount}"
            print(
                f"  [{i+1:5d}/{len(frames)}]  "
                f"det={len(detections):3d}  trk={len(tracks):3d}  "
                f"entries={total_entries}  exits={total_exits}"
                f"{density_str}  "
                f"det={avg_det:.0f}ms  trk={avg_trk:.0f}ms  "
                f"max_fps={max_fps:.1f}"
            )

    n = len(frames)
    print(f"\n{'='*60}")
    print(f"RESULTS: {n} frames processed")
    print(f"  Entries:  {total_entries}")
    print(f"  Exits:    {total_exits}")
    print(f"  Net flow: {total_entries - total_exits:+d}")
    print(f"\nTiming (avg per frame):")
    print(f"  Detection:  {total_det_time/n:.1f} ms")
    print(f"  Tracking:   {total_trk_time/n:.1f} ms")
    print(f"  Counting:   {total_cnt_time/n:.1f} ms")
    total_avg = (total_det_time + total_trk_time + total_cnt_time) / n
    print(f"  Total:      {total_avg:.1f} ms")
    print(f"  Max FPS:    {1000/total_avg:.1f}")
    print(f"  Wall time:  {(total_det_time + total_trk_time + total_cnt_time)/1000:.1f}s")


if __name__ == "__main__":
    main()
