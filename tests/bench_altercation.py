"""Check person detections and proximity in altercation video."""
import glob, math
from backend.eventdetect.model import YoloEventDetector, SecurityTracker

det = YoloEventDetector()
det.load()
tracker = SecurityTracker()

paths = sorted(glob.glob("demo/videos/security/altercation/*/frame_*.jpg", recursive=True))
print(f"Found {len(paths)} frames")

multi_person_frames = 0
min_dist_seen = 999.0

for i, p in enumerate(paths[:300]):
    raw = det.detect(p)
    tracked = tracker.update(raw)
    persons = [t for t in tracked if t["label"] == "person"]

    if i < 5 or i % 50 == 0:
        print(f"  frame {i:3d}: {len(raw)} dets, {len(tracked)} tracked, {len(persons)} persons")

    if len(persons) >= 2:
        multi_person_frames += 1
        for a in range(len(persons)):
            for b in range(a + 1, len(persons)):
                p1, p2 = persons[a], persons[b]
                cx1 = (p1["x1"] + p1["x2"]) / 2
                cy1 = (p1["y1"] + p1["y2"]) / 2
                cx2 = (p2["x1"] + p2["x2"]) / 2
                cy2 = (p2["y1"] + p2["y2"]) / 2
                dist = math.sqrt((cx1 - cx2) ** 2 + (cy1 - cy2) ** 2)
                if dist < min_dist_seen:
                    min_dist_seen = dist
                if multi_person_frames <= 5 or dist < 0.15:
                    s1 = p1.get("velocity")
                    s2 = p2.get("velocity")
                    sp1 = math.sqrt(s1[0]**2 + s1[1]**2) if s1 else 0
                    sp2 = math.sqrt(s2[0]**2 + s2[1]**2) if s2 else 0
                    print(f"    PAIR frame {i:3d}: {p1['track_id']}-{p2['track_id']}  dist={dist:.4f}  speeds={sp1:.5f},{sp2:.5f}")

print()
print(f"Multi-person frames: {multi_person_frames}/300")
print(f"Min distance seen: {min_dist_seen:.4f}")
print(f"Current altercation threshold: 0.06")
