# Backend Replay Scaffold

This package provides deterministic replay primitives for the refactor.

- `models.py` defines the replay request/result shapes.
- `runner.py` executes a handler over a frame sequence and collects structured outputs.
- `artifacts.py` persists replay runs as `manifest.json` plus `steps.jsonl`.
- `fixtures.py` provides a small deterministic sample request for tests and examples.

The design is intentionally generic so later detector, tracker, and state modules can plug into it without changing the artifact format.
