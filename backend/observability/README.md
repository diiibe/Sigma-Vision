# Backend Observability Helpers

This package contains the support code for the refactor's operational layer.

- `metrics.py` defines the canonical Prometheus metric names and a fallback-safe metrics bundle.
- `alerts.py` evaluates threshold rules into structured alert events.
- `timeline.py` buckets and rolls up time-series points for short history views.
- `consistency.py` surfaces stale-state and reconciliation issues as first-class signals.
- `logging.py` provides a simple structured logging shim.

These helpers are intentionally framework-light so they can be imported before the main app wiring is finished.
