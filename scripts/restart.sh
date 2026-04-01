#!/bin/bash
# Clean restart: kills stale backend on port 8000, then launches npm run dev.
# Usage: bash scripts/restart.sh

set -e

echo "[restart] Checking port 8000..."
PID=$(lsof -t -i :8000 2>/dev/null || true)
if [ -n "$PID" ]; then
  echo "[restart] Killing PID $PID on port 8000"
  kill -9 $PID 2>/dev/null || true
  sleep 2
fi

# Also kill any uvicorn specifically
pkill -9 -f 'uvicorn backend.app' 2>/dev/null || true
sleep 1

# Final check
if lsof -i :8000 2>/dev/null | grep -q LISTEN; then
  echo "[restart] ERROR: port 8000 still busy!"
  exit 1
fi

echo "[restart] Port 8000 free — starting..."
exec npm run dev
