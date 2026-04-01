"""Test export endpoints against live server."""
import json
import urllib.request

API = "http://localhost:8000"

def get(path):
    try:
        return urllib.request.urlopen(f"{API}{path}", timeout=5).read().decode()
    except Exception as e:
        return f"ERROR: {e}"

# Test counting export
print("=== Counting Events CSV ===")
data = get("/api/export/counting")
lines = data.strip().split("\n")
print(f"Lines: {len(lines)} (including header)")
if len(lines) > 1:
    print(f"Header: {lines[0]}")
    print(f"First row: {lines[1]}")
else:
    print("EMPTY - only header")
    print(f"Header: {lines[0] if lines else 'NONE'}")

print()

# Test density export
print("=== Density CSV ===")
data = get("/api/export/density")
lines = data.strip().split("\n")
print(f"Lines: {len(lines)} (including header)")
if len(lines) > 1:
    print(f"First row: {lines[1]}")
else:
    print("EMPTY - only header")

print()

# Test security export
print("=== Security Events CSV ===")
data = get("/api/export/security")
lines = data.strip().split("\n")
print(f"Lines: {len(lines)} (including header)")
if len(lines) > 1:
    print(f"First row: {lines[1]}")
else:
    print("EMPTY - only header")

# Check what's in counting cache
print()
print("=== Counting State ===")
try:
    # Check if any counting cameras have active data
    cameras = json.loads(urllib.request.urlopen(f"{API}/api/cameras/ids", timeout=2).read())
    for cam in cameras[:3]:
        try:
            state = json.loads(urllib.request.urlopen(f"{API}/api/live/counting-state/{cam}", timeout=2).read())
            tc = state.get("trafficCounting")
            if tc:
                events = tc.get("countingEvents", [])
                print(f"  {cam}: {len(events)} live counting events, entries={tc.get('entriesTotal',0)} exits={tc.get('exitsTotal',0)}")
            else:
                print(f"  {cam}: no traffic counting")
        except:
            print(f"  {cam}: failed to fetch")
except Exception as e:
    print(f"  Error: {e}")
