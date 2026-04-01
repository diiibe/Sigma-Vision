from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Mapping

from .models import ReplayFrame, ReplayRunRequest, ReplayRunResult, ReplayStepOutput


ReplayHandler = Callable[[ReplayFrame], Mapping[str, object]]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass
class ReplayRunner:
    handler: ReplayHandler

    def run(self, request: ReplayRunRequest) -> ReplayRunResult:
        started_at = _utc_now()
        steps: list[ReplayStepOutput] = []

        for frame in request.frames:
            outputs = dict(self.handler(frame))
            steps.append(
                ReplayStepOutput(
                    frame_id=frame.frame_id,
                    captured_at=frame.captured_at,
                    outputs=outputs,
                )
            )

        finished_at = _utc_now()
        summary = _summarize_steps(request, steps)

        return ReplayRunResult(
            run_id=request.run_id,
            camera_id=request.camera_id,
            source_label=request.source_label,
            started_at=started_at,
            finished_at=finished_at,
            status="completed",
            step_count=len(steps),
            summary=summary,
            steps=steps,
        )


def _summarize_steps(
    request: ReplayRunRequest,
    steps: list[ReplayStepOutput],
) -> dict[str, object]:
    detection_count = 0
    track_count = 0
    alert_count = 0
    event_count = 0

    for step in steps:
        payload = step.outputs
        detection_count += len(payload.get("detections", []))
        track_count += len(payload.get("tracks", []))
        alert_count += len(payload.get("alerts", []))
        event_count += len(payload.get("events", []))

    return {
        "runId": request.run_id,
        "frames": len(request.frames),
        "detections": detection_count,
        "tracks": track_count,
        "alerts": alert_count,
        "events": event_count,
    }
