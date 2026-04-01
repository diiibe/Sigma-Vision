# Runtime Storage Reset

This is a one-time operational runbook for moving from the legacy SQLite-only layout to the new deployment-oriented storage split:

- canonical config lives in JSON under `backend/state/canonical/spatial-configs/`
- runtime history lives in SQLite under `backend/state/runtime/runtime.sqlite`

## Goal

Keep only the active global matrix as recovery material, discard legacy runtime history, and restart the app on the new storage layout.

## 1. Export the active global config from the old DB

Legacy DB path:

```bash
backend/runtime/hack26.db
```

Create a recovery folder:

```bash
mkdir -p backend/state/recovery/$(date -u +%Y%m%dT%H%M%SZ)
```

Export the active `__global__` config:

```bash
sqlite3 backend/runtime/hack26.db "
  SELECT config_json
  FROM spatial_config_versions
  WHERE camera_id = '__global__' AND status = 'active'
  ORDER BY version DESC
  LIMIT 1;
" > backend/state/recovery/<timestamp>/active-global.json
```

Write a minimal manifest with source metadata:

```json
{
  "timestamp": "2026-03-24T00:00:00Z",
  "sourceDbPath": "backend/runtime/hack26.db",
  "notes": "One-time export before switching to backend/state/"
}
```

Save that as:

```text
backend/state/recovery/<timestamp>/manifest.json
```

## 2. Seed the canonical config store

Create the canonical layout:

```bash
mkdir -p backend/state/canonical/spatial-configs/versions
```

Copy the exported config as version 1:

```bash
cp backend/state/recovery/<timestamp>/active-global.json \
  backend/state/canonical/spatial-configs/versions/000001.json
```

Create `backend/state/canonical/spatial-configs/manifest.json`:

```json
{
  "activeVersion": 1,
  "latestVersion": 1,
  "versions": [
    {
      "cameraId": "PTL1",
      "version": 1,
      "status": "active",
      "createdAt": "2026-03-24T00:00:00Z",
      "updatedAt": "2026-03-24T00:00:00Z",
      "activatedAt": "2026-03-24T00:00:00Z",
      "presetName": "Recovered active global config",
      "copiedFromCameraId": null,
      "copiedFromVersion": null,
      "bayCount": 0,
      "zoneCount": 0,
      "lineCount": 0
    }
  ]
}
```

Use the real values from the exported config when filling `cameraId`, timestamps and counts.

## 3. Retire the old runtime DB

Rename or remove the legacy DB so the app cannot keep using it by mistake:

```bash
mv backend/runtime/hack26.db backend/runtime/hack26.db.legacy
```

## 4. Restart the app

On restart the backend will:

- read canonical config from `backend/state/canonical/spatial-configs/`
- recreate `backend/state/runtime/runtime.sqlite`
- rebuild runtime-only history from scratch

## Notes

- Do not copy snapshots, events, or timeline history into the new runtime DB.
- Do not copy old per-camera config rows into the canonical store.
- If no canonical manifest exists, the app falls back to `demo/lot-definition.json` for development only.
