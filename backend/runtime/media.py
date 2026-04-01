from __future__ import annotations

from fastapi.responses import FileResponse, Response

from ..models import SpatialConfig
from .frame_paths import resolve_frame_asset_path
from .spatial_config import polygon_bounds


def frame_response(config: SpatialConfig, frame_id: str) -> Response:
    frame = next((item for item in config.frames if item.id == frame_id), None)
    if frame is None:
        return Response(status_code=404)

    image_path = resolve_frame_asset_path(frame.imagePath)
    if image_path and image_path.exists():
        return FileResponse(image_path)

    return Response(content=build_placeholder_frame(config, frame_id), media_type="image/svg+xml")


def build_placeholder_frame(config: SpatialConfig, frame_id: str) -> str:
    bay_paths = []
    for bay in config.bays:
        x1, y1, x2, y2 = polygon_bounds(bay.layoutPolygon)
        bay_paths.append(
            f'<rect x="{x1 * 1280:.2f}" y="{y1 * 720:.2f}" width="{max((x2 - x1) * 1280, 8):.2f}" '
            f'height="{max((y2 - y1) * 720, 8):.2f}" fill="rgba(255,255,255,0.04)" '
            f'stroke="rgba(214,225,255,0.18)" stroke-width="2" />'
        )

    svg = f"""
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#2f3640" />
          <stop offset="100%" stop-color="#14181e" />
        </linearGradient>
      </defs>
      <rect width="1280" height="720" fill="url(#bg)" />
      <g opacity="0.35">
        <path d="M0 120 L1280 84" stroke="#d9dde4" stroke-width="6" stroke-dasharray="18 16" />
        <path d="M0 250 L1280 206" stroke="#d9dde4" stroke-width="6" stroke-dasharray="18 16" />
        <path d="M0 400 L1280 350" stroke="#d9dde4" stroke-width="6" stroke-dasharray="18 16" />
        <path d="M0 560 L1280 520" stroke="#d9dde4" stroke-width="8" stroke-dasharray="26 22" />
      </g>
      <g opacity="0.88">{''.join(bay_paths)}</g>
      <text x="60" y="78" fill="#edf2fb" font-size="34" font-family="IBM Plex Sans, sans-serif">{frame_id}</text>
      <text x="60" y="112" fill="#bcc7d8" font-size="20" font-family="IBM Plex Mono, monospace">{config.camera.name}</text>
    </svg>
    """.strip()

    return svg
