# ── Stage 1: Build frontend ──────────────────────────────────────
FROM node:22-alpine AS frontend-build

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY src/ src/
COPY public/ public/
RUN npx vite build


# ── Stage 2: Python runtime ──────────────────────────────────────
FROM python:3.11-slim AS runtime

# System deps for OpenCV (used by ultralytics) and nginx
RUN apt-get update && apt-get install -y --no-install-recommends \
    nginx \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python dependencies (cached layer)
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# Download RCNN weights from R2 (90 MB)
RUN python3 -c "\
import requests; \
from pathlib import Path; \
p = Path('demo-assets/weights'); \
p.mkdir(parents=True, exist_ok=True); \
r = requests.get('https://pub-e8bbdcbe8f6243b2a9933704a9b1d8bc.r2.dev/parking%2FRCNN_128_square_gopro.pt', timeout=300); \
r.raise_for_status(); \
(p / 'RCNN_128_square_gopro.pt').write_bytes(r.content); \
print(f'Downloaded RCNN weights: {len(r.content)} bytes')"

# Backend source code
COPY backend/ backend/

# YOLO models
COPY yolo11s.pt yolo11s.pt

# Demo lot definition
COPY demo/lot-definition.json demo/lot-definition.json

# Demo videos (all cameras including security)
COPY demo/videos/ demo/videos/

# Pre-bake demo state snapshot (databases, configs, clips)
# These get copied into working dirs at runtime only in DEMO_MODE=1
COPY backend/state/dev-blank/ demo-state-snapshot/dev-blank/
COPY backend/state/canonical/ demo-state-snapshot/canonical/
COPY backend/state/security.db demo-state-snapshot/security.db
COPY backend/state/event-clips/ demo-state-snapshot/event-clips/

# nginx config
COPY docker/nginx.conf /etc/nginx/nginx.conf

# Built frontend
COPY --from=frontend-build /build/dist/ /usr/share/nginx/html/

# Entrypoint
COPY docker/entrypoint.sh /entrypoint.sh

# Clean working state (demo data lives in demo-state-snapshot, restored at runtime)
RUN rm -rf backend/state/dev-blank backend/state/runtime backend/state/canonical backend/state/event-clips && \
    rm -f backend/state/security.db backend/state/.DS_Store && \
    mkdir -p backend/state/event-clips

ENV HACK26_DEMO_ASSETS_DIR=/app/demo-assets
ENV HACK26_CORS_ORIGINS=*
ENV HACK26_BOOTSTRAP_LAYOUT=blank

EXPOSE 5173

ENTRYPOINT ["/entrypoint.sh"]
