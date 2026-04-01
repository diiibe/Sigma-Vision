from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping


@dataclass(frozen=True)
class ReplayFrame:
    frame_id: str
    camera_id: str
    captured_at: str
    payload: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ReplayStepOutput:
    frame_id: str
    captured_at: str
    outputs: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ReplayRunRequest:
    run_id: str
    camera_id: str
    source_label: str
    frames: list[ReplayFrame]
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ReplayRunResult:
    run_id: str
    camera_id: str
    source_label: str
    started_at: str
    finished_at: str
    status: str
    step_count: int
    summary: Mapping[str, Any] = field(default_factory=dict)
    steps: list[ReplayStepOutput] = field(default_factory=list)
