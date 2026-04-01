from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path

from ..models import (
    AlertEvent,
    BayOverrideState,
    CameraVideoSourceState,
    CountingAggregatePoint,
    CountingEvent,
    DensitySnapshot,
    EventHistoryPage,
    FlowCounts,
    LiveStateSnapshot,
    ObservationDefinition,
    SystemEvent,
    TimelinePoint,
)
from .spatial_config import iso_now


class SQLiteStore:
    def __init__(
        self,
        db_path: Path,
        *,
        snapshot_retention: int = 300,
        event_retention: int = 2000,
        timeline_retention: int = 1000,
    ):
        self.db_path = db_path
        self.snapshot_retention = max(snapshot_retention, 0)
        self.event_retention = max(event_retention, 0)
        self.timeline_retention = max(timeline_retention, 0)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self._ensure_schema()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def list_active_overrides(self, camera_id: str | None = None) -> list[BayOverrideState]:
        query = """
            SELECT bay_id, camera_id, status, active, updated_at, reason
            FROM bay_overrides
            WHERE active = 1
        """
        params: tuple[object, ...] = ()
        if camera_id is not None:
            query += " AND camera_id = ?"
            params = (camera_id,)
        query += " ORDER BY bay_id ASC"
        with self._lock:
            rows = self._conn.execute(query, params).fetchall()
        return [
            BayOverrideState(
                bayId=row["bay_id"],
                cameraId=row["camera_id"],
                status=row["status"],
                active=bool(row["active"]),
                updatedAt=row["updated_at"],
                reason=row["reason"],
            )
            for row in rows
        ]

    def get_override(self, bay_id: str) -> BayOverrideState | None:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT bay_id, camera_id, status, active, updated_at, reason
                FROM bay_overrides
                WHERE bay_id = ?
                LIMIT 1
                """,
                (bay_id,),
            ).fetchone()
        if row is None:
            return None
        return BayOverrideState(
            bayId=row["bay_id"],
            cameraId=row["camera_id"],
            status=row["status"],
            active=bool(row["active"]),
            updatedAt=row["updated_at"],
            reason=row["reason"],
        )

    def upsert_override(self, override: BayOverrideState) -> BayOverrideState:
        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT INTO bay_overrides (
                    bay_id, camera_id, status, active, updated_at, reason
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(bay_id) DO UPDATE SET
                    camera_id = excluded.camera_id,
                    status = excluded.status,
                    active = excluded.active,
                    updated_at = excluded.updated_at,
                    reason = excluded.reason
                """,
                (
                    override.bayId,
                    override.cameraId,
                    override.status,
                    1 if override.active else 0,
                    override.updatedAt,
                    override.reason,
                ),
            )
        return override

    def clear_override(self, bay_id: str, updated_at: str | None = None) -> BayOverrideState | None:
        existing = self.get_override(bay_id)
        if existing is None:
            return None
        cleared = existing.model_copy(update={"status": "cleared", "active": False, "updatedAt": updated_at or iso_now()})
        self.upsert_override(cleared)
        return cleared

    def rename_override_bay_id(self, camera_id: str, old_bay_id: str, new_bay_id: str) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                """
                UPDATE bay_overrides
                SET bay_id = ?
                WHERE bay_id = ?
                """,
                (new_bay_id, old_bay_id),
            )

    def upsert_video_source(self, source: CameraVideoSourceState) -> CameraVideoSourceState:
        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT INTO camera_video_sources (
                    camera_id, source_path, cache_dir, status, discovered_at, updated_at,
                    normalized_fps, input_fps, duration_seconds, width, height, frame_count,
                    source_signature, current_frame_index, current_frame_id, current_frame_path,
                    last_tick_at, loop_count, error
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(camera_id) DO UPDATE SET
                    source_path = excluded.source_path,
                    cache_dir = excluded.cache_dir,
                    status = excluded.status,
                    discovered_at = excluded.discovered_at,
                    updated_at = excluded.updated_at,
                    normalized_fps = excluded.normalized_fps,
                    input_fps = excluded.input_fps,
                    duration_seconds = excluded.duration_seconds,
                    width = excluded.width,
                    height = excluded.height,
                    frame_count = excluded.frame_count,
                    source_signature = excluded.source_signature,
                    current_frame_index = excluded.current_frame_index,
                    current_frame_id = excluded.current_frame_id,
                    current_frame_path = excluded.current_frame_path,
                    last_tick_at = excluded.last_tick_at,
                    loop_count = excluded.loop_count,
                    error = excluded.error
                """,
                (
                    source.cameraId,
                    source.sourcePath,
                    source.cacheDir,
                    source.status,
                    source.discoveredAt,
                    source.updatedAt,
                    source.normalizedFps,
                    source.inputFps,
                    source.durationSeconds,
                    source.width,
                    source.height,
                    source.frameCount,
                    source.sourceSignature,
                    source.currentFrameIndex,
                    source.currentFrameId,
                    source.currentFramePath,
                    source.lastTickAt,
                    source.loopCount,
                    source.error,
                ),
            )
        return source

    def get_video_source(self, camera_id: str) -> CameraVideoSourceState | None:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT *
                FROM camera_video_sources
                WHERE camera_id = ?
                LIMIT 1
                """,
                (camera_id,),
            ).fetchone()
        if row is None:
            return None
        return CameraVideoSourceState(
            cameraId=row["camera_id"],
            sourcePath=row["source_path"],
            cacheDir=row["cache_dir"],
            status=row["status"],
            discoveredAt=row["discovered_at"],
            updatedAt=row["updated_at"],
            normalizedFps=row["normalized_fps"],
            inputFps=row["input_fps"],
            durationSeconds=row["duration_seconds"],
            width=row["width"],
            height=row["height"],
            frameCount=row["frame_count"],
            sourceSignature=row["source_signature"],
            currentFrameIndex=row["current_frame_index"],
            currentFrameId=row["current_frame_id"],
            currentFramePath=row["current_frame_path"],
            lastTickAt=row["last_tick_at"],
            loopCount=row["loop_count"],
            error=row["error"],
        )

    def list_video_sources(self) -> list[CameraVideoSourceState]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT *
                FROM camera_video_sources
                ORDER BY camera_id ASC
                """
            ).fetchall()
        return [
            CameraVideoSourceState(
                cameraId=row["camera_id"],
                sourcePath=row["source_path"],
                cacheDir=row["cache_dir"],
                status=row["status"],
                discoveredAt=row["discovered_at"],
                updatedAt=row["updated_at"],
                normalizedFps=row["normalized_fps"],
                inputFps=row["input_fps"],
                durationSeconds=row["duration_seconds"],
                width=row["width"],
                height=row["height"],
                frameCount=row["frame_count"],
                sourceSignature=row["source_signature"],
                currentFrameIndex=row["current_frame_index"],
                currentFrameId=row["current_frame_id"],
                currentFramePath=row["current_frame_path"],
                lastTickAt=row["last_tick_at"],
                loopCount=row["loop_count"],
                error=row["error"],
            )
            for row in rows
        ]

    def list_video_source_ids(self) -> list[str]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT camera_id
                FROM camera_video_sources
                ORDER BY camera_id ASC
                """
            ).fetchall()
        return [row["camera_id"] for row in rows]

    def save_live_snapshot(self, snapshot: LiveStateSnapshot) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT INTO live_state_snapshots (
                    camera_id, captured_at, revision, snapshot_json
                ) VALUES (?, ?, ?, ?)
                """,
                (
                    snapshot.cameraId,
                    snapshot.capturedAt,
                    self.next_revision(snapshot.cameraId),
                    snapshot.model_dump_json(),
                ),
            )
            self._prune_table("live_state_snapshots", snapshot.cameraId, self.snapshot_retention)

    def next_revision(self, camera_id: str) -> int:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT COALESCE(MAX(revision), 0) + 1 AS revision
                FROM live_state_snapshots
                WHERE camera_id = ?
                """,
                (camera_id,),
            ).fetchone()
        return int(row["revision"] if row else 1)

    def get_latest_live_snapshot(self, camera_id: str | None = None) -> LiveStateSnapshot | None:
        query = """
            SELECT snapshot_json
            FROM live_state_snapshots
        """
        params: tuple[object, ...] = ()
        if camera_id:
            query += " WHERE camera_id = ?"
            params = (camera_id,)
        query += " ORDER BY revision DESC LIMIT 1"
        with self._lock:
            row = self._conn.execute(query, params).fetchone()
        if row is None:
            return None
        return LiveStateSnapshot.model_validate_json(row["snapshot_json"])

    def append_event(self, camera_id: str, event: SystemEvent | dict[str, object]) -> None:
        if isinstance(event, SystemEvent):
            payload = event.model_dump()
            timestamp = event.timestamp
        else:
            payload = event
            timestamp = str(event.get("timestamp", ""))
        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT INTO live_events (camera_id, timestamp, event_json)
                VALUES (?, ?, ?)
                """,
                (camera_id, timestamp, json.dumps(payload)),
            )
            self._prune_table("live_events", camera_id, self.event_retention)

    def list_events(
        self,
        *,
        camera_id: str | None = None,
        cursor: str | None = None,
        limit: int = 50,
    ) -> EventHistoryPage:
        safe_limit = max(1, min(limit, 100))
        batch_size = max(safe_limit * 2, 50)
        valid_rows: list[tuple[int, SystemEvent]] = []
        next_cursor_value = int(cursor) if cursor is not None else None

        with self._lock:
            while len(valid_rows) < safe_limit + 1:
                query = """
                    SELECT id, event_json
                    FROM live_events
                """
                clauses: list[str] = []
                params: list[object] = []
                if camera_id is not None:
                    clauses.append("camera_id = ?")
                    params.append(camera_id)
                if next_cursor_value is not None:
                    clauses.append("id < ?")
                    params.append(next_cursor_value)
                if clauses:
                    query += f" WHERE {' AND '.join(clauses)}"
                query += " ORDER BY id DESC LIMIT ?"
                params.append(batch_size)
                rows = self._conn.execute(query, tuple(params)).fetchall()
                if not rows:
                    break
                next_cursor_value = int(rows[-1]["id"])
                for row in rows:
                    try:
                        event = SystemEvent.model_validate_json(row["event_json"])
                    except Exception:
                        continue
                    valid_rows.append((int(row["id"]), event))
                if len(rows) < batch_size:
                    break

        page_rows = valid_rows[:safe_limit]
        items = [item for _, item in page_rows]
        next_cursor = str(page_rows[-1][0]) if len(valid_rows) > safe_limit and page_rows else None
        return EventHistoryPage(items=items, nextCursor=next_cursor)

    def append_timeline_point(self, camera_id: str, point: TimelinePoint) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT INTO timeline_points (camera_id, bucket_start, point_json)
                VALUES (?, ?, ?)
                """,
                (camera_id, point.bucketStart, point.model_dump_json()),
            )
            self._prune_table("timeline_points", camera_id, self.timeline_retention)

    def list_timeline_points(self, camera_id: str, limit: int = 30) -> list[TimelinePoint]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT point_json
                FROM timeline_points
                WHERE camera_id = ?
                ORDER BY rowid DESC
                LIMIT ?
                """,
                (camera_id, limit),
            ).fetchall()
        return [TimelinePoint.model_validate_json(row["point_json"]) for row in reversed(rows)]

    # --- Observation CRUD ---

    def list_observations(self, camera_id: str | None = None) -> list[ObservationDefinition]:
        with self._lock:
            if camera_id:
                rows = self._conn.execute(
                    "SELECT * FROM observations WHERE camera_id = ? ORDER BY created_at",
                    (camera_id,),
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT * FROM observations ORDER BY created_at",
                ).fetchall()
        return [self._row_to_observation(r) for r in rows]

    def get_observation(self, observation_id: str) -> ObservationDefinition | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM observations WHERE id = ?",
                (observation_id,),
            ).fetchone()
        return self._row_to_observation(row) if row else None

    def upsert_observation(self, obs: ObservationDefinition) -> ObservationDefinition:
        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT INTO observations
                    (id, name, camera_id, task_type, points_json,
                     association_type, association_id, capacity_threshold,
                     enabled, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    camera_id = excluded.camera_id,
                    task_type = excluded.task_type,
                    points_json = excluded.points_json,
                    association_type = excluded.association_type,
                    association_id = excluded.association_id,
                    capacity_threshold = excluded.capacity_threshold,
                    enabled = excluded.enabled,
                    updated_at = excluded.updated_at
                """,
                (
                    obs.id,
                    obs.name,
                    obs.cameraId,
                    obs.taskType,
                    json.dumps([list(p) for p in obs.points]),
                    obs.associationType,
                    obs.associationId,
                    obs.capacityThreshold,
                    1 if obs.enabled else 0,
                    obs.createdAt,
                    obs.updatedAt,
                ),
            )
        return obs

    def delete_observation(self, observation_id: str) -> bool:
        with self._lock, self._conn:
            cursor = self._conn.execute(
                "DELETE FROM observations WHERE id = ?",
                (observation_id,),
            )
        return cursor.rowcount > 0

    def toggle_observation(self, observation_id: str, enabled: bool) -> ObservationDefinition | None:
        with self._lock, self._conn:
            self._conn.execute(
                "UPDATE observations SET enabled = ?, updated_at = ? WHERE id = ?",
                (1 if enabled else 0, self._iso_now(), observation_id),
            )
        return self.get_observation(observation_id)

    @staticmethod
    def _row_to_observation(row) -> ObservationDefinition:
        points_raw = json.loads(row["points_json"])
        return ObservationDefinition(
            id=row["id"],
            name=row["name"],
            cameraId=row["camera_id"],
            taskType=row["task_type"],
            points=[tuple(p) for p in points_raw],
            associationType=row["association_type"],
            associationId=row["association_id"],
            capacityThreshold=row["capacity_threshold"],
            enabled=bool(row["enabled"]),
            createdAt=row["created_at"],
            updatedAt=row["updated_at"],
        )

    # ── Counting sessions ──

    def start_counting_session(self, session_id: str, obs: ObservationDefinition) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                """INSERT OR REPLACE INTO counting_sessions
                   (id, observation_id, observation_name, camera_id, task_type, started_at, status)
                   VALUES (?, ?, ?, ?, ?, ?, 'active')""",
                (session_id, obs.id, obs.name, obs.cameraId, obs.taskType, self._iso_now()),
            )

    def stop_counting_session(self, session_id: str, entries: int, exits: int) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                """UPDATE counting_sessions
                   SET stopped_at = ?, entries = ?, exits = ?, status = 'completed'
                   WHERE id = ?""",
                (self._iso_now(), entries, exits, session_id),
            )

    def update_counting_session(self, session_id: str, entries: int, exits: int) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "UPDATE counting_sessions SET entries = ?, exits = ? WHERE id = ?",
                (entries, exits, session_id),
            )

    def list_counting_sessions(self, camera_id: str | None = None, limit: int = 50) -> list[dict]:
        where = ""
        params: list[object] = []
        if camera_id:
            where = "WHERE camera_id = ?"
            params.append(camera_id)
        params.append(limit)
        rows = self._conn.execute(
            f"SELECT * FROM counting_sessions {where} ORDER BY started_at DESC LIMIT ?",
            params,
        ).fetchall()
        return [dict(r) for r in rows]

    def get_active_sessions(self, camera_id: str) -> list[dict]:
        rows = self._conn.execute(
            "SELECT * FROM counting_sessions WHERE camera_id = ? AND status = 'active' ORDER BY started_at",
            (camera_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    @staticmethod
    def _iso_now() -> str:
        from datetime import datetime, timezone
        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # --- Counting module CRUD ---

    def append_counting_event(self, event: CountingEvent) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT OR IGNORE INTO counting_events (
                    event_id, camera_id, line_id, event_type, track_id,
                    timestamp, association_type, association_id, event_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event.id,
                    event.cameraId,
                    event.lineId,
                    event.eventType,
                    event.trackId,
                    event.timestamp,
                    event.associationType,
                    event.associationId,
                    event.model_dump_json(),
                ),
            )
            self._prune_counting_events(event.cameraId, 10000)

    def list_counting_events(
        self,
        *,
        camera_id: str | None = None,
        line_id: str | None = None,
        since: str | None = None,
        limit: int = 100,
    ) -> list[CountingEvent]:
        clauses: list[str] = []
        params: list[object] = []
        if camera_id is not None:
            clauses.append("camera_id = ?")
            params.append(camera_id)
        if line_id is not None:
            clauses.append("line_id = ?")
            params.append(line_id)
        if since is not None:
            clauses.append("timestamp >= ?")
            params.append(since)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        params.append(max(1, min(limit, 500)))
        with self._lock:
            rows = self._conn.execute(
                f"SELECT event_json FROM counting_events{where} ORDER BY id DESC LIMIT ?",
                tuple(params),
            ).fetchall()
        return [CountingEvent.model_validate_json(row["event_json"]) for row in rows]

    def count_events_since(
        self,
        since: str,
        *,
        association_type: str | None = None,
        association_id: str | None = None,
    ) -> FlowCounts:
        clauses = ["timestamp >= ?"]
        params: list[object] = [since]
        if association_type is not None:
            clauses.append("association_type = ?")
            params.append(association_type)
        if association_id is not None:
            clauses.append("association_id = ?")
            params.append(association_id)
        where = " AND ".join(clauses)
        with self._lock:
            row = self._conn.execute(
                f"""
                SELECT
                    COALESCE(SUM(CASE WHEN event_type = 'entry' THEN 1 ELSE 0 END), 0) AS entries,
                    COALESCE(SUM(CASE WHEN event_type = 'exit' THEN 1 ELSE 0 END), 0) AS exits
                FROM counting_events
                WHERE {where}
                """,
                tuple(params),
            ).fetchone()
        return FlowCounts(
            entriesTotal=int(row["entries"]),
            exitsTotal=int(row["exits"]),
            entriesLastHour=int(row["entries"]),
            exitsLastHour=int(row["exits"]),
        )

    def append_density_snapshot(self, snapshot: DensitySnapshot) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT INTO density_snapshots (
                    zone_id, camera_id, timestamp, vehicle_count, snapshot_json
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    snapshot.zoneId,
                    snapshot.cameraId,
                    snapshot.timestamp,
                    snapshot.vehicleCount,
                    snapshot.model_dump_json(),
                ),
            )
            self._prune_density_snapshots(snapshot.cameraId, 5000)

    def list_density_snapshots(
        self,
        *,
        zone_id: str | None = None,
        since: str | None = None,
        limit: int = 50,
    ) -> list[DensitySnapshot]:
        clauses: list[str] = []
        params: list[object] = []
        if zone_id is not None:
            clauses.append("zone_id = ?")
            params.append(zone_id)
        if since is not None:
            clauses.append("timestamp >= ?")
            params.append(since)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        params.append(max(1, min(limit, 500)))
        with self._lock:
            rows = self._conn.execute(
                f"SELECT snapshot_json FROM density_snapshots{where} ORDER BY id DESC LIMIT ?",
                tuple(params),
            ).fetchall()
        return [DensitySnapshot.model_validate_json(row["snapshot_json"]) for row in rows]

    def upsert_counting_aggregate(self, point: CountingAggregatePoint) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT INTO counting_aggregates (
                    bucket_start, granularity, entries, exits, net_flow,
                    association_type, association_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(bucket_start, granularity, association_type, association_id) DO UPDATE SET
                    entries = counting_aggregates.entries + excluded.entries,
                    exits = counting_aggregates.exits + excluded.exits,
                    net_flow = counting_aggregates.net_flow + excluded.net_flow
                """,
                (
                    point.bucketStart,
                    point.granularity,
                    point.entries,
                    point.exits,
                    point.netFlow,
                    point.associationType,
                    point.associationId,
                ),
            )

    def list_counting_aggregates(
        self,
        granularity: str = "hourly",
        *,
        since: str | None = None,
        until: str | None = None,
        association_type: str | None = None,
        association_id: str | None = None,
        limit: int = 168,
    ) -> list[CountingAggregatePoint]:
        clauses = ["granularity = ?"]
        params: list[object] = [granularity]
        if since is not None:
            clauses.append("bucket_start >= ?")
            params.append(since)
        if until is not None:
            clauses.append("bucket_start <= ?")
            params.append(until)
        if association_type is not None:
            clauses.append("association_type = ?")
            params.append(association_type)
        if association_id is not None:
            clauses.append("association_id = ?")
            params.append(association_id)
        where = " AND ".join(clauses)
        params.append(max(1, min(limit, 1000)))
        with self._lock:
            rows = self._conn.execute(
                f"""
                SELECT bucket_start, granularity, entries, exits, net_flow,
                       association_type, association_id
                FROM counting_aggregates
                WHERE {where}
                ORDER BY bucket_start DESC
                LIMIT ?
                """,
                tuple(params),
            ).fetchall()
        return [
            CountingAggregatePoint(
                bucketStart=row["bucket_start"],
                bucketEnd=row["bucket_start"],
                granularity=row["granularity"],
                entries=row["entries"],
                exits=row["exits"],
                netFlow=row["net_flow"],
                associationType=row["association_type"] or "facility",
                associationId=row["association_id"],
            )
            for row in reversed(rows)
        ]

    def _prune_counting_events(self, camera_id: str, retention: int) -> None:
        self._conn.execute(
            """
            DELETE FROM counting_events
            WHERE camera_id = ?
              AND id NOT IN (
                SELECT id FROM counting_events WHERE camera_id = ?
                ORDER BY id DESC LIMIT ?
              )
            """,
            (camera_id, camera_id, retention),
        )

    def _prune_density_snapshots(self, camera_id: str, retention: int) -> None:
        self._conn.execute(
            """
            DELETE FROM density_snapshots
            WHERE camera_id = ?
              AND id NOT IN (
                SELECT id FROM density_snapshots WHERE camera_id = ?
                ORDER BY id DESC LIMIT ?
              )
            """,
            (camera_id, camera_id, retention),
        )

    def _prune_table(self, table_name: str, camera_id: str, retention_limit: int) -> None:
        if retention_limit <= 0:
            return
        self._conn.execute(
            f"""
            DELETE FROM {table_name}
            WHERE camera_id = ?
              AND id NOT IN (
                SELECT id
                FROM {table_name}
                WHERE camera_id = ?
                ORDER BY id DESC
                LIMIT ?
              )
            """,
            (camera_id, camera_id, retention_limit),
        )

    def _ensure_schema(self) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS live_state_snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    camera_id TEXT NOT NULL,
                    captured_at TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    snapshot_json TEXT NOT NULL
                )
                """
            )
            self._conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_live_state_snapshots_camera_revision
                ON live_state_snapshots(camera_id, revision DESC)
                """
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS live_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    camera_id TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    event_json TEXT NOT NULL
                )
                """
            )
            self._conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_live_events_camera_id
                ON live_events(camera_id, id DESC)
                """
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS timeline_points (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    camera_id TEXT NOT NULL,
                    bucket_start TEXT NOT NULL,
                    point_json TEXT NOT NULL
                )
                """
            )
            self._conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_timeline_points_camera_bucket
                ON timeline_points(camera_id, bucket_start DESC)
                """
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS replay_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    camera_id TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    finished_at TEXT,
                    run_json TEXT NOT NULL
                )
                """
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS bay_overrides (
                    bay_id TEXT PRIMARY KEY,
                    camera_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    active INTEGER NOT NULL DEFAULT 1,
                    updated_at TEXT NOT NULL,
                    reason TEXT
                )
                """
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS camera_video_sources (
                    camera_id TEXT PRIMARY KEY,
                    source_path TEXT,
                    cache_dir TEXT,
                    status TEXT NOT NULL,
                    discovered_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    normalized_fps REAL NOT NULL,
                    input_fps REAL,
                    duration_seconds REAL,
                    width INTEGER,
                    height INTEGER,
                    frame_count INTEGER NOT NULL DEFAULT 0,
                    source_signature TEXT,
                    current_frame_index INTEGER NOT NULL DEFAULT 0,
                    current_frame_id TEXT,
                    current_frame_path TEXT,
                    last_tick_at TEXT,
                    loop_count INTEGER NOT NULL DEFAULT 0,
                    error TEXT
                )
                """
            )
            # --- Counting module tables ---
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS counting_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_id TEXT UNIQUE NOT NULL,
                    camera_id TEXT NOT NULL,
                    line_id TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    track_id TEXT,
                    timestamp TEXT NOT NULL,
                    association_type TEXT DEFAULT 'facility',
                    association_id TEXT,
                    event_json TEXT NOT NULL
                )
                """
            )
            self._conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_counting_events_camera
                ON counting_events(camera_id, timestamp DESC)
                """
            )
            self._conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_counting_events_line
                ON counting_events(line_id, timestamp DESC)
                """
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS density_snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    zone_id TEXT NOT NULL,
                    camera_id TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    vehicle_count INTEGER NOT NULL,
                    snapshot_json TEXT NOT NULL
                )
                """
            )
            self._conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_density_zone
                ON density_snapshots(zone_id, timestamp DESC)
                """
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS counting_aggregates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    bucket_start TEXT NOT NULL,
                    granularity TEXT NOT NULL,
                    entries INTEGER DEFAULT 0,
                    exits INTEGER DEFAULT 0,
                    net_flow INTEGER DEFAULT 0,
                    association_type TEXT DEFAULT 'facility',
                    association_id TEXT,
                    UNIQUE(bucket_start, granularity, association_type, association_id)
                )
                """
            )
            self._conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_agg_bucket
                ON counting_aggregates(bucket_start DESC, granularity)
                """
            )

            # ── Observations (vehicle analysis tasks) ──
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS observations (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    camera_id TEXT NOT NULL,
                    task_type TEXT NOT NULL,
                    points_json TEXT NOT NULL,
                    association_type TEXT DEFAULT 'facility',
                    association_id TEXT,
                    capacity_threshold INTEGER,
                    enabled INTEGER DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            self._conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_observations_camera
                ON observations(camera_id)
                """
            )

            # ── Counting sessions (task run log) ──
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS counting_sessions (
                    id TEXT PRIMARY KEY,
                    observation_id TEXT NOT NULL,
                    observation_name TEXT NOT NULL,
                    camera_id TEXT NOT NULL,
                    task_type TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    stopped_at TEXT,
                    entries INTEGER NOT NULL DEFAULT 0,
                    exits INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'active'
                )
                """
            )
            self._conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_counting_sessions_camera
                ON counting_sessions(camera_id, started_at DESC)
                """
            )
