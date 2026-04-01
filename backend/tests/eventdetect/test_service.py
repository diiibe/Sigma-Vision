import time
import numpy as np
import cv2
from unittest.mock import MagicMock

from backend.eventdetect.service import EventDetectionService
from backend.eventdetect.schemas import EventDetectionConfig, MonitoredClass


def _make_test_video(path: str, num_frames: int = 120, fps: float = 30.0):
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(path, fourcc, fps, (64, 64))
    for i in range(num_frames):
        frame = np.full((64, 64, 3), i % 256, dtype=np.uint8)
        writer.write(frame)
    writer.release()


class TestServiceLifecycle:
    def test_initial_state(self):
        svc = EventDetectionService()
        state = svc.get_state()
        assert state.running is False
        assert state.events == []

    def test_start_sets_running(self, tmp_path):
        video_path = str(tmp_path / "test.mp4")
        _make_test_video(video_path)

        svc = EventDetectionService()
        config = EventDetectionConfig(
            video_path=video_path,
            classes=[MonitoredClass(label="Fighting_Videos", label_id=6, enabled=True)],
        )

        mock_model = MagicMock()
        mock_model.labels = [f"class_{i}" for i in range(14)]
        mock_model.normal_label = "Normal_Videos_event"
        mock_model.predict.return_value = {f"class_{i}": 0.05 for i in range(14)}
        svc._model = mock_model

        state = svc.start(config)
        assert state.running is True
        time.sleep(0.3)
        svc.stop()
        assert svc.get_state().running is False

    def test_stop_without_start(self):
        svc = EventDetectionService()
        state = svc.stop()
        assert state.running is False

    def test_get_events_empty(self):
        svc = EventDetectionService()
        assert svc.get_events() == []
