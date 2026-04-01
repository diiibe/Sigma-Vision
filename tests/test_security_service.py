"""Tests for SecurityService — lifecycle and state management."""

import tempfile
import time
from pathlib import Path

import pytest
from backend.eventdetect.schemas import SecurityTask, SecurityZone
from backend.eventdetect.storage import SecurityStore
from backend.eventdetect.service import SecurityService


def _make_service():
    """Create a SecurityService with a temporary database."""
    svc = SecurityService.__new__(SecurityService)
    import threading
    svc._lock = threading.RLock()
    svc._detector = None
    svc._video_ingestion = None
    svc._own_video_ingestion = None
    svc._parent_service = None
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    svc._store = SecurityStore(Path(tmp.name))
    svc._tasks = {}
    svc._camera_threads = {}
    svc._camera_states = {}
    svc._camera_video_times = {}
    svc._event_counts = {}
    svc._events = []
    return svc


def _make_task(cam_id="cam1", task_id="t1", enabled=True):
    return SecurityTask(
        id=task_id,
        cameraId=cam_id,
        zones=[SecurityZone(
            id="z1", name="Test", points=[(0.2, 0.2), (0.8, 0.2), (0.8, 0.8), (0.2, 0.8)],
        )],
        lines=[],
        sampleRate=4,
        enabled=enabled,
    )


class TestTaskCRUD:
    def test_create_and_list(self):
        svc = _make_service()
        task = _make_task()
        created = svc.create_task(task)
        assert created.id == "t1"
        tasks = svc.list_tasks()
        assert len(tasks) == 1
        assert tasks[0].cameraId == "cam1"

    def test_delete_task(self):
        svc = _make_service()
        svc.create_task(_make_task())
        assert svc.delete_task("t1") is True
        assert len(svc.list_tasks()) == 0

    def test_delete_nonexistent(self):
        svc = _make_service()
        assert svc.delete_task("nope") is False

    def test_toggle_task(self):
        svc = _make_service()
        svc.create_task(_make_task(enabled=False))
        result = svc.toggle_task("t1", True)
        assert result is not None
        assert result.enabled is True

    def test_toggle_nonexistent(self):
        svc = _make_service()
        assert svc.toggle_task("nope", True) is None


class TestServiceState:
    def test_initial_state(self):
        svc = _make_service()
        state = svc.get_service_state()
        assert state.tasks == []
        assert state.events == []
        assert state.activeCameras == []

    def test_camera_state_empty(self):
        svc = _make_service()
        cs = svc.get_camera_state("cam1")
        assert cs.tracks == []
        assert cs.frameIndex == 0

    def test_events_empty(self):
        svc = _make_service()
        evts = svc.get_events()
        assert evts == []


class TestLifecycle:
    def test_stop_without_start(self):
        """stop() should not raise even without active threads."""
        svc = _make_service()
        svc.stop()  # should not raise

    def test_double_create_replaces(self):
        """Creating a task for the same camera twice should not crash."""
        svc = _make_service()
        svc.create_task(_make_task(task_id="t1"))
        svc.create_task(_make_task(task_id="t2"))
        assert len(svc.list_tasks()) == 2
        svc.stop()
