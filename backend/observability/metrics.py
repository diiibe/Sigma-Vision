from __future__ import annotations

from dataclasses import dataclass
from typing import Any

try:  # pragma: no cover - optional dependency in this workspace.
    from prometheus_client import CollectorRegistry, Counter, Gauge, generate_latest
except Exception:  # pragma: no cover - exercised when the package is unavailable.
    CollectorRegistry = None  # type: ignore[assignment]
    Counter = Gauge = None  # type: ignore[assignment]

    def generate_latest(*_args: Any, **_kwargs: Any) -> bytes:
        return b""


METRIC_NAMES = {
    "input_fps": "hack26_input_fps",
    "dropped_frames": "hack26_dropped_frames_total",
    "detector_latency_ms": "hack26_detector_latency_ms",
    "tracker_latency_ms": "hack26_tracker_latency_ms",
    "end_to_end_state_latency_ms": "hack26_end_to_end_state_latency_ms",
    "active_tracks": "hack26_active_tracks",
    "active_alerts": "hack26_active_alerts",
    "state_inconsistencies": "hack26_state_inconsistencies_total",
    "stale_data_incidents": "hack26_stale_data_incidents_total",
    "processing_errors": "hack26_processing_errors_total",
}


class _NoopMetric:
    def inc(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    def dec(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    def set(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    def observe(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    def labels(self, *_args: Any, **_kwargs: Any) -> "_NoopMetric":
        return self


@dataclass
class MetricHandle:
    name: str
    kind: str
    description: str
    metric: Any
    value: float = 0.0

    def inc(self, amount: float = 1.0) -> None:
        self.value += amount
        if hasattr(self.metric, "inc"):
            self.metric.inc(amount)

    def dec(self, amount: float = 1.0) -> None:
        self.value -= amount
        if hasattr(self.metric, "dec"):
            self.metric.dec(amount)

    def set(self, value: float) -> None:
        previous = self.value
        self.value = value
        if self.kind == "gauge" and hasattr(self.metric, "set"):
            self.metric.set(value)
        elif self.kind == "counter" and hasattr(self.metric, "inc"):
            delta = value - previous
            if delta > 0:
                self.metric.inc(delta)

    def observe(self, value: float) -> None:
        self.value = value
        if hasattr(self.metric, "observe"):
            self.metric.observe(value)


@dataclass
class MetricsBundle:
    registry: Any
    input_fps: MetricHandle
    dropped_frames: MetricHandle
    detector_latency_ms: MetricHandle
    tracker_latency_ms: MetricHandle
    end_to_end_state_latency_ms: MetricHandle
    active_tracks: MetricHandle
    active_alerts: MetricHandle
    state_inconsistencies: MetricHandle
    stale_data_incidents: MetricHandle
    processing_errors: MetricHandle

    def snapshot(self) -> dict[str, float]:
        return {
            "input_fps": self.input_fps.value,
            "dropped_frames": self.dropped_frames.value,
            "detector_latency_ms": self.detector_latency_ms.value,
            "tracker_latency_ms": self.tracker_latency_ms.value,
            "end_to_end_state_latency_ms": self.end_to_end_state_latency_ms.value,
            "active_tracks": self.active_tracks.value,
            "active_alerts": self.active_alerts.value,
            "state_inconsistencies": self.state_inconsistencies.value,
            "stale_data_incidents": self.stale_data_incidents.value,
            "processing_errors": self.processing_errors.value,
        }

    def record_pipeline_state(
        self,
        *,
        input_fps: float | None = None,
        dropped_frames: float | None = None,
        detector_latency_ms: float | None = None,
        tracker_latency_ms: float | None = None,
        end_to_end_state_latency_ms: float | None = None,
        active_tracks: float | None = None,
        active_alerts: float | None = None,
        state_inconsistencies: float | None = None,
        stale_data_incidents: float | None = None,
        processing_errors: float | None = None,
    ) -> None:
        updates = {
            "input_fps": input_fps,
            "dropped_frames": dropped_frames,
            "detector_latency_ms": detector_latency_ms,
            "tracker_latency_ms": tracker_latency_ms,
            "end_to_end_state_latency_ms": end_to_end_state_latency_ms,
            "active_tracks": active_tracks,
            "active_alerts": active_alerts,
            "state_inconsistencies": state_inconsistencies,
            "stale_data_incidents": stale_data_incidents,
            "processing_errors": processing_errors,
        }

        for name, value in updates.items():
            if value is None:
                continue
            getattr(self, name).set(float(value))


def create_metrics_bundle(namespace: str = "hack26", registry: Any | None = None) -> MetricsBundle:
    registry = registry or (CollectorRegistry() if CollectorRegistry is not None else None)

    def build(name: str, kind: str, description: str) -> MetricHandle:
        metric_name = METRIC_NAMES[name]
        if kind == "counter" and Counter is not None:
            metric = Counter(metric_name, description, registry=registry)
        elif kind == "gauge" and Gauge is not None:
            metric = Gauge(metric_name, description, registry=registry)
        else:
            metric = _NoopMetric()

        return MetricHandle(name=metric_name, kind=kind, description=description, metric=metric)

    return MetricsBundle(
        registry=registry,
        input_fps=build("input_fps", "gauge", f"{namespace} input frame rate"),
        dropped_frames=build("dropped_frames", "counter", f"{namespace} dropped frames"),
        detector_latency_ms=build("detector_latency_ms", "gauge", f"{namespace} detector latency"),
        tracker_latency_ms=build("tracker_latency_ms", "gauge", f"{namespace} tracker latency"),
        end_to_end_state_latency_ms=build(
            "end_to_end_state_latency_ms",
            "gauge",
            f"{namespace} end-to-end state latency",
        ),
        active_tracks=build("active_tracks", "gauge", f"{namespace} active tracks"),
        active_alerts=build("active_alerts", "gauge", f"{namespace} active alerts"),
        state_inconsistencies=build(
            "state_inconsistencies",
            "counter",
            f"{namespace} state inconsistencies",
        ),
        stale_data_incidents=build(
            "stale_data_incidents",
            "counter",
            f"{namespace} stale data incidents",
        ),
        processing_errors=build("processing_errors", "counter", f"{namespace} processing errors"),
    )


def export_metrics_text(bundle: MetricsBundle) -> str:
    if bundle.registry is None:
        items = {
            bundle.input_fps.name: bundle.input_fps.value,
            bundle.dropped_frames.name: bundle.dropped_frames.value,
            bundle.detector_latency_ms.name: bundle.detector_latency_ms.value,
            bundle.tracker_latency_ms.name: bundle.tracker_latency_ms.value,
            bundle.end_to_end_state_latency_ms.name: bundle.end_to_end_state_latency_ms.value,
            bundle.active_tracks.name: bundle.active_tracks.value,
            bundle.active_alerts.name: bundle.active_alerts.value,
            bundle.state_inconsistencies.name: bundle.state_inconsistencies.value,
            bundle.stale_data_incidents.name: bundle.stale_data_incidents.value,
            bundle.processing_errors.name: bundle.processing_errors.value,
        }
        return "\n".join(f"{key} {value}" for key, value in sorted(items.items()))

    return generate_latest(bundle.registry).decode("utf-8")
