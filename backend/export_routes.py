"""CSV export endpoints — completely independent, no modifications to existing code."""

from __future__ import annotations

import csv
import io
import tempfile
from pathlib import Path

from fastapi import APIRouter, Query
from fastapi.responses import FileResponse, Response


def create_export_router(get_service, get_security_service) -> APIRouter:
    router = APIRouter(prefix="/api/export", tags=["export"])

    @router.get("/counting")
    async def export_counting_csv(
        since: str | None = Query(None),
        until: str | None = Query(None),
    ):
        service = get_service()
        db_events = service.store.list_counting_events(since=since, limit=50000)
        seen_ids = {e.id for e in db_events}
        live_events = []

        try:
            for cache in service.pipeline._counting_cache.values():
                for e in cache.get("all_events", []):
                    if e.id not in seen_ids:
                        live_events.append(e)
                        seen_ids.add(e.id)
        except Exception:
            pass

        try:
            for cam_id in service.pipeline.list_camera_ids():
                snap = service.pipeline.state.latest_snapshot(cam_id)
                if snap and snap.trafficCounting:
                    for e in snap.trafficCounting.countingEvents:
                        if e.id not in seen_ids:
                            live_events.append(e)
                            seen_ids.add(e.id)
        except Exception:
            pass

        all_events = db_events + live_events
        if until:
            all_events = [e for e in all_events if e.timestamp <= until]

        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["id", "timestamp", "camera_id", "line_id", "event_type", "direction", "track_id", "confidence"])
        for e in all_events:
            writer.writerow([e.id, e.timestamp, e.cameraId, e.lineId, e.eventType, e.direction, e.trackId, round(e.confidence, 3)])

        return Response(
            content=buf.getvalue(),
            media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=counting_events.csv"},
        )

    @router.get("/density")
    async def export_density_csv(
        since: str | None = Query(None),
        until: str | None = Query(None),
    ):
        service = get_service()
        db_snapshots = service.store.list_density_snapshots(since=since, limit=50000)
        seen = set()
        for s in db_snapshots:
            seen.add(f"{s.zoneId}:{s.timestamp}")

        live_snapshots = []
        try:
            for cache in service.pipeline._counting_cache.values():
                for s in cache.get("pending_density", []):
                    key = f"{s.zoneId}:{s.timestamp}"
                    if key not in seen:
                        live_snapshots.append(s)
                        seen.add(key)
        except Exception:
            pass

        try:
            for cam_id in service.pipeline.list_camera_ids():
                snap = service.pipeline.state.latest_snapshot(cam_id)
                if snap and snap.trafficCounting:
                    for s in snap.trafficCounting.densitySnapshots:
                        key = f"{s.zoneId}:{s.timestamp}"
                        if key not in seen:
                            live_snapshots.append(s)
                            seen.add(key)
        except Exception:
            pass

        all_snapshots = db_snapshots + live_snapshots
        if until:
            all_snapshots = [s for s in all_snapshots if s.timestamp <= until]

        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["timestamp", "camera_id", "zone_id", "vehicle_count", "capacity", "occupancy_ratio"])
        for s in all_snapshots:
            writer.writerow([s.timestamp, s.cameraId, s.zoneId, s.vehicleCount, s.capacity or "", round(s.occupancyRatio, 3) if s.occupancyRatio else ""])

        return Response(
            content=buf.getvalue(),
            media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=density_snapshots.csv"},
        )

    @router.get("/security")
    async def export_security_csv(
        since: str | None = Query(None),
        until: str | None = Query(None),
    ):
        sec_service = get_security_service()
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["id", "timestamp", "camera_id", "event_type", "track_ids", "confidence", "zone_id"])

        if sec_service is not None:
            events = sec_service._store.list_events(limit=50000)
            if since:
                events = [e for e in events if e.timestamp >= since]
            if until:
                events = [e for e in events if e.timestamp <= until]
            for ev in events:
                writer.writerow([ev.id, ev.timestamp, ev.cameraId, ev.eventType, ";".join(ev.trackIds), round(ev.confidence, 3), ev.zoneId or ""])

        return Response(
            content=buf.getvalue(),
            media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=security_events.csv"},
        )

    return router
