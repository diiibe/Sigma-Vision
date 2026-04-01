# Ops Artifacts

This directory holds operational artifacts that support the refactor.

- `grafana/hack26-dashboard.json` is a Prometheus-based dashboard template for the live pipeline.
- The dashboard uses the canonical metric names defined in `backend/observability/metrics.py`.

These files are intentionally static so they can be imported into a local Grafana stack without pulling runtime code into the UI.
