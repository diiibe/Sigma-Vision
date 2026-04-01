from backend.eventdetect.schemas import (
    MonitoredClass,
    EventDetectionConfig,
    DetectedEvent,
    WindowPrediction,
    EventDetectionState,
)


def test_monitored_class_defaults():
    mc = MonitoredClass(label="Fighting_Videos", label_id=6)
    assert mc.enabled is False
    assert mc.threshold == 0.60


def test_config_defaults():
    cfg = EventDetectionConfig(video_path="/tmp/test.mp4", classes=[])
    assert cfg.sample_rate == 4
    assert cfg.smoothing_window == 3
    assert cfg.debounce_seconds == 5.0


def test_detected_event_roundtrip():
    ev = DetectedEvent(
        id="evt-001",
        event_type="Fighting_Videos",
        family="physical_conflict",
        confidence=0.82,
        start_sec=10.5,
        end_sec=12.3,
        detected_at="2026-03-30T12:00:00Z",
    )
    d = ev.model_dump()
    assert d["clip_path"] is None
    ev2 = DetectedEvent.model_validate(d)
    assert ev2.id == "evt-001"


def test_window_prediction():
    wp = WindowPrediction(
        window_id=0,
        center_sec=1.5,
        predictions={"Fighting_Videos": 0.8, "Normal_Videos_event": 0.15},
        anomaly_score=0.85,
        dominant_label="Fighting_Videos",
        dominant_confidence=0.8,
    )
    assert wp.anomaly_score == 0.85


def test_state_defaults():
    st = EventDetectionState(running=False)
    assert st.events == []
    assert st.last_prediction is None
    assert st.current_sec == 0.0
