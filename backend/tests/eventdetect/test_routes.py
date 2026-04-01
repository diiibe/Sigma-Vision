from fastapi import FastAPI
from fastapi.testclient import TestClient
from backend.eventdetect.routes import create_event_detection_router
from backend.eventdetect.service import EventDetectionService


def _make_app() -> tuple[FastAPI, EventDetectionService]:
    app = FastAPI()
    svc = EventDetectionService()
    app.include_router(create_event_detection_router(svc))
    return app, svc


def test_get_state():
    app, _ = _make_app()
    client = TestClient(app)
    r = client.get("/api/event-detection/state")
    assert r.status_code == 200
    body = r.json()
    assert body["running"] is False
    assert body["events"] == []


def test_get_events_empty():
    app, _ = _make_app()
    client = TestClient(app)
    r = client.get("/api/event-detection/events")
    assert r.status_code == 200
    assert r.json() == []


def test_stop_without_start():
    app, _ = _make_app()
    client = TestClient(app)
    r = client.post("/api/event-detection/stop")
    assert r.status_code == 200
    assert r.json()["running"] is False


def test_start_missing_video():
    app, _ = _make_app()
    client = TestClient(app)
    r = client.post(
        "/api/event-detection/start",
        json={"video_path": "/nonexistent/video.mp4", "classes": []},
    )
    assert r.status_code == 400
