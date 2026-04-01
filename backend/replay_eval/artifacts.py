from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path
from typing import Iterable

from .models import ReplayRunResult, ReplayStepOutput


class ReplayArtifactStore:
    def __init__(self, root_dir: Path):
        self.root_dir = root_dir

    def list_runs(self) -> list[str]:
        if not self.root_dir.exists():
            return []

        return sorted(entry.name for entry in self.root_dir.iterdir() if entry.is_dir())

    def write(self, result: ReplayRunResult) -> Path:
        run_dir = self.root_dir / result.run_id
        run_dir.mkdir(parents=True, exist_ok=True)
        (run_dir / "manifest.json").write_text(
            json.dumps(
                {
                    **asdict(result),
                    "steps": [],
                },
                indent=2,
                sort_keys=True,
            ),
            encoding="utf-8",
        )
        self._write_steps(run_dir / "steps.jsonl", result.steps)
        return run_dir

    def read(self, run_id: str) -> ReplayRunResult:
        run_dir = self.root_dir / run_id
        manifest = json.loads((run_dir / "manifest.json").read_text(encoding="utf-8"))
        steps = self._read_steps(run_dir / "steps.jsonl")

        return ReplayRunResult(
            run_id=manifest["run_id"],
            camera_id=manifest["camera_id"],
            source_label=manifest["source_label"],
            started_at=manifest["started_at"],
            finished_at=manifest["finished_at"],
            status=manifest["status"],
            step_count=manifest["step_count"],
            summary=manifest.get("summary", {}),
            steps=steps,
        )

    def _write_steps(self, path: Path, steps: Iterable[ReplayStepOutput]) -> None:
        with path.open("w", encoding="utf-8") as handle:
            for step in steps:
                handle.write(json.dumps(asdict(step), sort_keys=True))
                handle.write("\n")

    def _read_steps(self, path: Path) -> list[ReplayStepOutput]:
        if not path.exists():
            return []

        steps: list[ReplayStepOutput] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            payload = json.loads(line)
            steps.append(
                ReplayStepOutput(
                    frame_id=payload["frame_id"],
                    captured_at=payload["captured_at"],
                    outputs=payload.get("outputs", {}),
                )
            )
        return steps
