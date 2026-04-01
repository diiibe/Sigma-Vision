# Hack26 Parking Operations App

This repository contains a parking operations prototype with two connected products:

- a **Live Operations Dashboard** for monitoring the lot in real time
- a **Spatial Config Editor** for defining and versioning the lot layout used by the live system

The important architectural change is that the **backend is now the source of truth** for live state and spatial configuration. The frontend is mainly responsible for presentation and local UI state.

## What The App Is

At a high level, this app is trying to answer two different needs:

1. **What is happening in the lot right now?**
   The live dashboard shows occupancy, camera state, alerts, counts, event history, and the current lot view.

2. **How is the lot defined?**
   The config editor lets you manage the geometry and metadata that the live pipeline uses: bays, zones, lines, versions, and active configuration.

These two parts are connected. The live dashboard is driven by the currently active spatial configuration.

## Main User Flows

### Live mode

Open the app at `/live`.

The root route `/` redirects here.

This mode shows:

- current facility status
- bay occupancy and zone rollups
- a selected camera feed
- an event log
- alerts
- the 3D lot view

The dashboard does not invent this state locally anymore. It reads a backend snapshot and updates when the backend changes.

### Config mode

Open the app at `/config`.

This mode lets you:

- load the active spatial config for the current camera
- inspect config versions
- edit bays, zones, lines, and metadata
- save a draft version
- activate a selected version
- request a fresh live preview

`/editor` still exists as a temporary alias and redirects to `/config`.

## How The App Works

The system now follows this general flow:

```text
demo/lot-definition.json
  -> converted into a global SpatialConfig
  -> stored as canonical JSON versions
  -> one version is marked active in a manifest
  -> active config drives the live runtime pipeline
  -> pipeline produces a LiveStateSnapshot
  -> frontend reads snapshot over REST + SSE
  -> dashboard renders the result
```

### Startup

When the backend starts:

- it loads the canonical config manifest from `backend/state/canonical/spatial-configs/manifest.json` when available
- otherwise it seeds a canonical config from `demo/lot-definition.json`
- it stores runtime-only state in `backend/state/runtime/runtime.sqlite`
- scans `demo/videos/` for demo camera videos
- waits for the frontend to request live data

### Live snapshot generation

When the frontend requests live data:

- the backend loads the active config
- picks the current frame for that camera
- runs the deterministic pipeline
- assembles a `LiveStateSnapshot`
- stores the snapshot and timeline/event data in SQLite
- returns the snapshot to the UI

The current pipeline is deterministic on purpose. It produces stable, testable outputs without depending on the heavy optional ML stack.

### Config editing

When a user edits config:

- the editor loads the active config bundle from the backend
- local form changes stay in the browser until saved
- saving creates or updates a draft version in SQLite
- activating a version marks it as the live version
- the backend resets the runtime state for that camera so the next live snapshot uses the new config

## Architecture Overview

### Frontend

The frontend lives under `src/`.

Its main responsibilities are:

- routing between `/live` and `/config`
- calling backend APIs
- subscribing to live updates
- rendering the live dashboard
- rendering the config editor
- storing local UI state like selected slot, filters, and open panels

Important files:

- `src/App.tsx`: top-level routes and app wiring
- `src/api/parkingClient.ts`: browser client for REST and SSE
- `src/api/parkingClientMock.ts`: fallback/mock client for local UI use and tests
- `src/dashboard/`: live dashboard views
- `src/editor/LotEditorPage.tsx`: config editor
- `src/store/dashboardStore.ts`: frontend-only UI state

### Backend

The backend lives under `backend/`.

Its main responsibilities are:

- storing spatial config versions in SQLite
- keeping the active config
- generating live snapshots
- serving live frames
- validating config changes
- exposing REST and SSE APIs
- keeping compatibility with older `/api/demo/*` routes during the migration

Important files:

- `backend/app.py`: FastAPI app and route definitions
- `backend/demo_service.py`: thin compatibility service
- `backend/runtime/service.py`: backend orchestration layer
- `backend/runtime/pipeline.py`: deterministic live pipeline
- `backend/runtime/storage.py`: SQLite persistence
- `backend/runtime/validation.py`: spatial validation
- `backend/runtime/media.py`: frame serving and placeholder frames
- `backend/runtime/spatial_config.py`: conversion between legacy lot data and spatial config

### Shared Contracts

The app now uses a clearer shared runtime vocabulary.

The contract lives in:

- `contracts/parking-runtime.schema.json`
- `backend/models.py`
- `src/data/types.ts`

Key objects include:

- `SpatialConfig`
- `SpatialConfigBundle`
- `DetectionRecord`
- `TrackRecord`
- `BayState`
- `ZoneKpiState`
- `FlowEvent`
- `AlertEvent`
- `TimelinePoint`
- `ModuleHealth`
- `LiveStateSnapshot`

## The Current Runtime Pipeline

The backend pipeline currently runs through these steps:

1. **Video ingestion**
   If `demo/videos/` contains MP4 files, the demo treats each file as a camera feed. By default the camera ID is the MP4 filename stem, so `PTL1.mp4` becomes camera `PTL1`.

   The backend automatically creates one demo camera per discovered video and repartitions the lot so each camera owns a distinct section of the parking representation and its own polygon overlays.

   If you want different camera IDs than the filenames, you can add `demo/videos/video-map.json`, for example:

   ```json
   {
     "CAM-ACPDS-01": "PTL1.mp4",
     "CAM-02": "PTL2.mp4"
   }
   ```

   The backend normalizes playback to 5 FPS, extracts frames, and loops the video continuously.

2. **Detection**
   Produces deterministic vehicle detections.

3. **Tracking**
   Produces deterministic track IDs and persistence values.

4. **Association**
   Matches tracks to bays using geometry.

5. **Occupancy**
   Applies debounce rules before changing a bay from free to occupied or back.

6. **Zone rollup**
   Converts bay state into zone occupancy KPIs.

7. **Flow counting**
   Creates entry and exit events using enabled lines and cooldown rules.

8. **Alerts**
   Raises simple alerts, currently based on high zone occupancy.

9. **State assembly**
   Builds a single `LiveStateSnapshot` that the UI can consume.

10. **Persistence**
    Saves canonical configs as JSON and runtime history to SQLite.

## Data Storage

The app now splits persistence into canonical config storage and runtime storage.

Default state root:

- `backend/state/`

Canonical config store:

- `backend/state/canonical/spatial-configs/manifest.json`
- `backend/state/canonical/spatial-configs/versions/000001.json`

Runtime SQLite store:

- `backend/state/runtime/runtime.sqlite`

SQLite now stores only:

- live state snapshots
- live events
- timeline points
- replay run records
- bay overrides
- video source state

This keeps runtime history lightweight while the source of truth for layout/versioning stays deployment-friendly and file-based.

## APIs The Frontend Uses

The main frontend-facing APIs are:

- `GET /api/live/snapshot`
- `GET /api/live/stream`
- `GET /api/live/frame/{frame_id}`
- `GET /api/spatial-configs/{camera_id}/active`
- `GET /api/spatial-configs/{camera_id}/versions`
- `POST /api/spatial-configs/{camera_id}/versions`
- `POST /api/spatial-configs/{camera_id}/activate`

The old `/api/demo/*` endpoints still exist as temporary compatibility wrappers.

## Fallback Behavior

The app is designed to stay usable even when the backend is not available.

- If the API is offline, the frontend can fall back to `src/api/parkingClientMock.ts`
- If real frame images are missing, the backend serves generated placeholder frames

This keeps UI development and testing unblocked.

## Local Development

### 1. Install frontend dependencies

```bash
npm install
```

### 2. Create a Python environment

You can use any virtual environment location. A local `.venv` is the simplest option:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
```

### 3. Optional: bootstrap demo assets

```bash
python3 backend/scripts/bootstrap_demo_assets.py
```

Optional asset override:

```bash
export HACK26_DEMO_ASSETS_DIR=/absolute/path/to/demo-assets
```

Optional state root override:

```bash
export HACK26_STATE_DIR=/absolute/path/to/hack26-state
```

If assets are missing, the app can still run with placeholder frames and deterministic live data.

## Runtime Reset

The old `backend/runtime/hack26.db` is no longer part of the active architecture.

For the one-time backup/reset flow that exports only the active global config and rebuilds the new deployment-oriented state layout, use the runbook in [ops/runtime-storage-reset.md](/Users/dibe/Coding/hack26/ops/runtime-storage-reset.md).

### 4. Run the app

UI only:

```bash
npm run dev
```

Backend only:

```bash
source .venv/bin/activate
npm run dev:api
```

Full demo:

```bash
source .venv/bin/activate
npm run dev:demo
```

By default:

- the UI runs on `http://localhost:5173`
- the API runs on `http://localhost:8000`

## Tests

Frontend:

```bash
npm test
```

Backend:

```bash
python3 -m unittest discover -s backend/tests
```

Production build:

```bash
npm run build
```

## What Is Implemented Today

The refactor has already delivered the main structural changes:

- separate live and config routes
- backend-owned live snapshot model
- versioned spatial config storage in SQLite
- activation of config versions
- deterministic live pipeline
- SSE live stream
- config validation
- compatibility wrappers for old routes
- shared runtime contracts
- observability and replay scaffolding

## What Still Needs To Be Done

The app is now structurally correct, but not finished.

The main remaining work is:

- a richer visual editor for polygons and lines
- fuller use of timeline, counts, and module health in the live UI
- proper replay workflows exposed through the app
- full metrics endpoint and deeper observability wiring
- optional real detector/tracker adapters
- eventual removal of the legacy compatibility layer

## Related Docs

- `refactor.md`
- `docs/design-brief.md`
- `docs/target-architecture.md`
- `contracts/README.md`
- `ops/README.md`

## In One Sentence

This app is now a backend-driven parking operations system with a live dashboard on one side, a versioned spatial config editor on the other, and a deterministic runtime pipeline connecting them.
