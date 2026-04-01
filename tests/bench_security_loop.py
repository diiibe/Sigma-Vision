"""Benchmark: simulate the security _run() loop and measure FPS."""
import glob
import time

# Find JPEG frames
frames_dir = None
for d in glob.glob("demo/videos/*/"):
    jpgs = glob.glob(d + "*/frame_*.jpg")
    if len(jpgs) > 20:
        frames_dir = d
        break

if not frames_dir:
    # Try finding nested dirs
    import os
    for root, dirs, files in os.walk("demo/videos"):
        if any(f.startswith("frame_") and f.endswith(".jpg") for f in files):
            frames_dir = root
            break

assert frames_dir, "No frame cache found"
paths = sorted(glob.glob(frames_dir + "/**/frame_*.jpg", recursive=True))
print(f"Found {len(paths)} frames in {frames_dir}")

fps = 30.0  # assume 30fps
total = len(paths)

# Load model + tracker
from backend.eventdetect.model import YoloEventDetector, SecurityTracker

det = YoloEventDetector()
det.load()
tracker = SecurityTracker()

# Simulate _run() for 5 seconds
start_time = time.perf_counter()
start_frame = 0
tick_count = 0
frames_seen = set()

print()
print(f"{'tick':>4} {'elapsed':>8} {'frame':>6} {'dets':>5} {'trk':>4} {'ms':>7}")

while True:
    elapsed = time.perf_counter() - start_time
    if elapsed > 5.0:
        break

    frame_index = (start_frame + int(elapsed * fps)) % total

    t0 = time.perf_counter()
    raw = det.detect(paths[frame_index])
    tracked = tracker.update(raw)
    yolo_ms = (time.perf_counter() - t0) * 1000

    if tick_count < 15 or tick_count % 10 == 0:
        print(f"{tick_count:4d} {elapsed:7.3f}s {frame_index:6d} {len(raw):5d} {len(tracked):4d} {yolo_ms:6.1f}ms")

    frames_seen.add(frame_index)
    tick_count += 1

    time.sleep(0.01)

total_elapsed = time.perf_counter() - start_time
model_fps = tick_count / total_elapsed
unique = len(frames_seen)
expected = int(5 * fps)

print()
print("=== RESULTS ===")
print(f"Total ticks:        {tick_count}")
print(f"Unique frames:      {unique}")
print(f"Expected (5s@{fps}fps): {expected}")
print(f"Model FPS:          {model_fps:.1f}")
print(f"Coverage:           {unique}/{expected} = {100*unique/max(expected,1):.0f}%")
