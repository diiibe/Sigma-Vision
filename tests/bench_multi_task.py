"""Diagnose multi-task behavior: does second task restart from frame 0?"""
import json
import time
import urllib.request

API = "http://localhost:8000/api/security"


def get(path):
    try:
        return json.loads(urllib.request.urlopen(f"{API}/{path}", timeout=2).read())
    except Exception as e:
        return {"error": str(e)}


def post_json(path, data):
    body = json.dumps(data).encode()
    req = urllib.request.Request(f"{API}/{path}", data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=5).read())
    except Exception as e:
        return {"error": str(e)}


def patch(path):
    req = urllib.request.Request(f"{API}/{path}", method="PATCH")
    try:
        return json.loads(urllib.request.urlopen(req, timeout=2).read())
    except Exception as e:
        return {"error": str(e)}


def delete(path):
    req = urllib.request.Request(f"{API}/{path}", method="DELETE")
    try:
        return json.loads(urllib.request.urlopen(req, timeout=2).read())
    except Exception as e:
        return {"error": str(e)}


# Check cameras
cams = get("cameras")
print(f"Available cameras: {cams}")
if not cams or "error" in cams:
    print("No cameras or backend not running")
    exit()

cam = cams[0]

# Clean existing tasks
state = get("state")
for t in state.get("tasks", []):
    delete(f"tasks/{t['id']}")
    print(f"Deleted task {t['id']}")

# Create task A (altercation detection)
task_a = post_json("tasks", {
    "id": "", "cameraId": cam, "sampleRate": 4, "enabled": True,
    "zones": [{
        "id": "z-global-a", "name": "Task A - Altercation",
        "points": [[0, 0], [1, 0], [1, 1], [0, 1]],
        "detectEntry": False, "detectDwelling": False,
        "detectRunning": False, "detectChasing": False,
        "detectAltercation": True, "detectCrowdGathering": False,
        "dwellThresholdSec": 10, "speedThreshold": 0.012,
        "altercationProximity": 0.08, "crowdThreshold": 3
    }],
    "lines": []
})
print(f"\nCreated Task A: {task_a.get('id', 'ERROR')}")

# Wait for task A to start processing
print(f"\n=== Monitoring Task A for 3s ===")
time.sleep(0.5)
for i in range(15):
    cs = get(f"state/{cam}")
    fi = cs.get("frameIndex", -1)
    sec = cs.get("currentSec", 0)
    ntrk = len(cs.get("tracks", []))
    furl = cs.get("frameUrl", "")[-30:] if cs.get("frameUrl") else "none"
    print(f"  t={i*0.2:.1f}s  frame={fi:5d}  sec={sec:6.2f}  tracks={ntrk}  url=...{furl}")
    time.sleep(0.2)

last_frame_a = cs.get("frameIndex", 0)
last_sec_a = cs.get("currentSec", 0)
print(f"\nTask A position: frame={last_frame_a} sec={last_sec_a:.2f}")

# Now create task B (running detection) — same camera
print(f"\n=== Creating Task B on same camera ===")
task_b = post_json("tasks", {
    "id": "", "cameraId": cam, "sampleRate": 4, "enabled": True,
    "zones": [{
        "id": "z-global-b", "name": "Task B - Running",
        "points": [[0, 0], [1, 0], [1, 1], [0, 1]],
        "detectEntry": False, "detectDwelling": False,
        "detectRunning": True, "detectChasing": False,
        "detectAltercation": False, "detectCrowdGathering": False,
        "dwellThresholdSec": 10, "speedThreshold": 0.012,
        "altercationProximity": 0.08, "crowdThreshold": 3
    }],
    "lines": []
})
print(f"Created Task B: {task_b.get('id', 'ERROR')}")

# Monitor immediately after
print(f"\n=== Monitoring after Task B created (3s) ===")
time.sleep(0.3)
for i in range(15):
    cs = get(f"state/{cam}")
    fi = cs.get("frameIndex", -1)
    sec = cs.get("currentSec", 0)
    ntrk = len(cs.get("tracks", []))
    print(f"  t={i*0.2:.1f}s  frame={fi:5d}  sec={sec:6.2f}  tracks={ntrk}")
    time.sleep(0.2)

new_frame = cs.get("frameIndex", 0)
new_sec = cs.get("currentSec", 0)

print(f"\n=== DIAGNOSIS ===")
print(f"Task A last position: frame={last_frame_a} sec={last_sec_a:.2f}")
print(f"After Task B:         frame={new_frame} sec={new_sec:.2f}")

if new_frame < last_frame_a - 50:
    print(f"⚠ FRAME RESET: position jumped backwards by {last_frame_a - new_frame} frames")
    print(f"  The second task's runner likely reset the camera state to frame 0")
else:
    print(f"✓ Position continues forward — no reset detected")

# Check threading
state = get("state")
print(f"\nActive cameras: {state.get('activeCameras', [])}")
print(f"Tasks: {len(state.get('tasks', []))}")

# Cleanup
for t in state.get("tasks", []):
    delete(f"tasks/{t['id']}")
print("Cleaned up tasks")
