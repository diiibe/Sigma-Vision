#!/bin/sh
set -e

STATE_DIR="${HACK26_STATE_DIR:-backend/state}"

# Ensure state directories exist
mkdir -p "$STATE_DIR/runtime"
mkdir -p "$STATE_DIR/canonical/spatial-configs"
mkdir -p "backend/state/event-clips"

if [ "${DEMO_MODE:-0}" = "1" ]; then
    echo "[entrypoint] Demo mode: loading pre-baked state..."

    # Copy dev-blank state (main demo database)
    if [ -d "/app/demo-state-snapshot/dev-blank" ]; then
        cp -a /app/demo-state-snapshot/dev-blank/. "$STATE_DIR/"
    fi

    # Copy canonical spatial configs
    if [ -d "/app/demo-state-snapshot/canonical" ]; then
        mkdir -p "backend/state/canonical"
        cp -a /app/demo-state-snapshot/canonical/. "backend/state/canonical/"
    fi

    # Copy security database
    if [ -f "/app/demo-state-snapshot/security.db" ]; then
        cp /app/demo-state-snapshot/security.db "backend/state/security.db"
    fi

    # Copy event clips
    if [ -d "/app/demo-state-snapshot/event-clips" ]; then
        cp -a /app/demo-state-snapshot/event-clips/. "backend/state/event-clips/"
    fi

    echo "[entrypoint] Demo state loaded."
else
    echo "[entrypoint] Clean mode: starting with empty state."
fi

echo "[entrypoint] Starting nginx..."
nginx -g 'daemon on;'

echo "[entrypoint] Starting uvicorn on :8000..."
exec python3 -m uvicorn backend.app:app --host 0.0.0.0 --port 8000 --workers 1
