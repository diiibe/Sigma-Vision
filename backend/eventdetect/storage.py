"""SQLite storage for security tasks and events — independent from counting storage."""

from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path

from .schemas import SecurityEvent, SecurityTask, SecurityZone, SecurityLine

DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "state" / "security.db"


class SecurityStore:
    def __init__(self, db_path: Path | None = None):
        self.db_path = db_path or DEFAULT_DB_PATH
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._create_tables()

    def _create_tables(self) -> None:
        with self._lock, self._conn:
            self._conn.execute("""
                CREATE TABLE IF NOT EXISTS security_tasks (
                    id TEXT PRIMARY KEY,
                    camera_id TEXT NOT NULL,
                    zones_json TEXT NOT NULL,
                    lines_json TEXT NOT NULL,
                    sample_rate INTEGER DEFAULT 4,
                    enabled INTEGER DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            """)
            self._conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_security_tasks_camera
                ON security_tasks(camera_id)
            """)
            self._conn.execute("""
                CREATE TABLE IF NOT EXISTS security_events (
                    id TEXT PRIMARY KEY,
                    camera_id TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    track_ids_json TEXT NOT NULL,
                    confidence REAL NOT NULL,
                    timestamp TEXT NOT NULL,
                    timestamp_sec REAL DEFAULT 0,
                    zone_id TEXT,
                    line_id TEXT
                )
            """)
            self._conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_security_events_camera
                ON security_events(camera_id)
            """)

    # ── Tasks ──

    def list_tasks(self, camera_id: str | None = None) -> list[SecurityTask]:
        with self._lock:
            if camera_id:
                rows = self._conn.execute(
                    "SELECT * FROM security_tasks WHERE camera_id = ? ORDER BY created_at",
                    (camera_id,),
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT * FROM security_tasks ORDER BY created_at",
                ).fetchall()
        return [self._row_to_task(r) for r in rows]

    def get_task(self, task_id: str) -> SecurityTask | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM security_tasks WHERE id = ?", (task_id,),
            ).fetchone()
        return self._row_to_task(row) if row else None

    def upsert_task(self, task: SecurityTask) -> SecurityTask:
        from ..runtime.spatial_config import iso_now
        now = iso_now()
        with self._lock, self._conn:
            self._conn.execute("""
                INSERT INTO security_tasks
                    (id, camera_id, zones_json, lines_json, sample_rate, enabled, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    camera_id = excluded.camera_id,
                    zones_json = excluded.zones_json,
                    lines_json = excluded.lines_json,
                    sample_rate = excluded.sample_rate,
                    enabled = excluded.enabled,
                    updated_at = excluded.updated_at
            """, (
                task.id,
                task.cameraId,
                json.dumps([z.model_dump() for z in task.zones]),
                json.dumps([l.model_dump() for l in task.lines]),
                task.sampleRate,
                1 if task.enabled else 0,
                now,
                now,
            ))
        return task

    def delete_task(self, task_id: str) -> bool:
        with self._lock, self._conn:
            cursor = self._conn.execute(
                "DELETE FROM security_tasks WHERE id = ?", (task_id,),
            )
        return cursor.rowcount > 0

    def _row_to_task(self, row: sqlite3.Row) -> SecurityTask:
        zones_data = json.loads(row["zones_json"])
        lines_data = json.loads(row["lines_json"])
        return SecurityTask(
            id=row["id"],
            cameraId=row["camera_id"],
            zones=[SecurityZone(**z) for z in zones_data],
            lines=[SecurityLine(**l) for l in lines_data],
            sampleRate=row["sample_rate"],
            enabled=bool(row["enabled"]),
        )

    # ── Events ──

    def append_event(self, event: SecurityEvent) -> None:
        with self._lock, self._conn:
            self._conn.execute("""
                INSERT OR IGNORE INTO security_events
                    (id, camera_id, event_type, track_ids_json, confidence,
                     timestamp, timestamp_sec, zone_id, line_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                event.id,
                event.cameraId,
                event.eventType,
                json.dumps(event.trackIds),
                event.confidence,
                event.timestamp,
                event.timestampSec,
                event.zoneId,
                event.lineId,
            ))

    def list_events(
        self, camera_id: str | None = None, limit: int = 100,
    ) -> list[SecurityEvent]:
        with self._lock:
            if camera_id:
                rows = self._conn.execute(
                    "SELECT * FROM security_events WHERE camera_id = ? ORDER BY rowid DESC LIMIT ?",
                    (camera_id, limit),
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT * FROM security_events ORDER BY rowid DESC LIMIT ?",
                    (limit,),
                ).fetchall()
        return [self._row_to_event(r) for r in reversed(rows)]

    def _row_to_event(self, row: sqlite3.Row) -> SecurityEvent:
        return SecurityEvent(
            id=row["id"],
            cameraId=row["camera_id"],
            eventType=row["event_type"],
            trackIds=json.loads(row["track_ids_json"]),
            confidence=row["confidence"],
            timestamp=row["timestamp"],
            timestampSec=row["timestamp_sec"],
            zoneId=row["zone_id"],
            lineId=row["line_id"],
        )

    def close(self) -> None:
        self._conn.close()
