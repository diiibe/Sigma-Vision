import numpy as np
import cv2
from backend.eventdetect.pipeline import FrameSampler, SlidingWindowBuffer, EventPostProcessor


def _make_test_video(path: str, num_frames: int = 60, fps: float = 30.0):
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(path, fourcc, fps, (64, 64))
    for i in range(num_frames):
        frame = np.full((64, 64, 3), i % 256, dtype=np.uint8)
        writer.write(frame)
    writer.release()


class TestFrameSampler:
    def test_open_and_properties(self, tmp_path):
        video_path = str(tmp_path / "test.mp4")
        _make_test_video(video_path, num_frames=60, fps=30.0)
        sampler = FrameSampler(video_path, sample_rate=4)
        sampler.open()
        assert sampler.fps == 30.0
        assert sampler.duration_sec > 0
        sampler.close()

    def test_read_next_returns_frame_and_timestamp(self, tmp_path):
        video_path = str(tmp_path / "test.mp4")
        _make_test_video(video_path, num_frames=60, fps=30.0)
        sampler = FrameSampler(video_path, sample_rate=1)
        sampler.open()
        result = sampler.read_next()
        assert result is not None
        frame, ts = result
        assert isinstance(frame, np.ndarray)
        assert frame.ndim == 3
        assert ts >= 0.0
        sampler.close()

    def test_sample_rate_skips_frames(self, tmp_path):
        video_path = str(tmp_path / "test.mp4")
        _make_test_video(video_path, num_frames=60, fps=30.0)
        sampler = FrameSampler(video_path, sample_rate=4)
        sampler.open()
        frames_read = 0
        while True:
            result = sampler.read_next()
            if result is None:
                break
            frames_read += 1
        sampler.close()
        assert frames_read == 15

    def test_loops_when_video_ends(self, tmp_path):
        video_path = str(tmp_path / "test.mp4")
        _make_test_video(video_path, num_frames=30, fps=30.0)
        sampler = FrameSampler(video_path, sample_rate=1, loop=True)
        sampler.open()
        frames_read = 0
        for _ in range(45):
            result = sampler.read_next()
            if result is not None:
                frames_read += 1
        sampler.close()
        assert frames_read == 45


class TestSlidingWindowBuffer:
    def test_returns_none_until_full(self):
        buf = SlidingWindowBuffer(window_size=16, stride=8)
        frame = np.zeros((64, 64, 3), dtype=np.uint8)
        for i in range(15):
            result = buf.push(frame, float(i))
            assert result is None

    def test_returns_window_when_full(self):
        buf = SlidingWindowBuffer(window_size=16, stride=8)
        frame = np.zeros((64, 64, 3), dtype=np.uint8)
        for i in range(15):
            buf.push(frame, float(i))
        result = buf.push(frame, 15.0)
        assert result is not None
        assert len(result) == 16

    def test_stride_controls_next_window(self):
        buf = SlidingWindowBuffer(window_size=4, stride=2)
        frame = np.zeros((64, 64, 3), dtype=np.uint8)
        windows = []
        for i in range(10):
            result = buf.push(frame, float(i))
            if result is not None:
                windows.append(result)
        assert len(windows) >= 3

    def test_center_sec(self):
        buf = SlidingWindowBuffer(window_size=4, stride=2)
        frame = np.zeros((64, 64, 3), dtype=np.uint8)
        for i in range(4):
            buf.push(frame, float(i) * 0.5)
        assert buf.center_sec == 0.75


class TestEventPostProcessor:
    def test_no_event_below_threshold(self):
        proc = EventPostProcessor(smoothing_window=1, debounce_seconds=0.0)
        monitored = {"Fighting_Videos": 0.60}
        predictions = {"Fighting_Videos": 0.40, "Normal_Videos_event": 0.55}
        result = proc.process(predictions, 1.0, monitored)
        assert result is None

    def test_event_above_threshold(self):
        proc = EventPostProcessor(smoothing_window=1, debounce_seconds=0.0)
        monitored = {"Fighting_Videos": 0.60}
        predictions = {"Fighting_Videos": 0.80, "Normal_Videos_event": 0.10}
        result = proc.process(predictions, 1.0, monitored)
        assert result is not None
        assert result.event_type == "Fighting_Videos"
        assert result.confidence >= 0.80

    def test_debounce_suppresses_duplicate(self):
        proc = EventPostProcessor(smoothing_window=1, debounce_seconds=5.0)
        monitored = {"Fighting_Videos": 0.60}
        preds = {"Fighting_Videos": 0.80, "Normal_Videos_event": 0.10}
        r1 = proc.process(preds, 1.0, monitored)
        assert r1 is not None
        r2 = proc.process(preds, 3.0, monitored)
        assert r2 is None
        r3 = proc.process(preds, 7.0, monitored)
        assert r3 is not None

    def test_smoothing_averages_scores(self):
        proc = EventPostProcessor(smoothing_window=3, debounce_seconds=0.0)
        monitored = {"Fighting_Videos": 0.60}
        proc.process({"Fighting_Videos": 0.55, "Normal_Videos_event": 0.40}, 1.0, monitored)
        proc.process({"Fighting_Videos": 0.65, "Normal_Videos_event": 0.30}, 2.0, monitored)
        result = proc.process({"Fighting_Videos": 0.70, "Normal_Videos_event": 0.25}, 3.0, monitored)
        assert result is not None
