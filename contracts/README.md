# Parking Runtime Contracts

This directory holds the shared canonical contract schema for the refactor.

The schema is intentionally backend- and frontend-agnostic:

- `SpatialConfig` covers versioned camera layouts, bays, zones, and counting lines.
- `DetectionRecord` and `TrackRecord` describe the perception pipeline outputs.
- `BayState`, `ZoneKpiState`, `FlowEvent`, `AlertEvent`, `TimelinePoint`, and `ModuleHealth` describe the live operational model.
- `LiveStateSnapshot` is the read model consumed by the dashboard.

The goal is to keep the runtime vocabulary frozen while the implementation underneath is still being rebuilt.
