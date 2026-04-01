from __future__ import annotations

import json
import re
import sys
import zipfile
from pathlib import Path

import requests
from PIL import Image


ROOT_DIR = Path(__file__).resolve().parents[2]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from backend.demo_paths import (  # noqa: E402
    DEMO_ASSETS_ENV_VAR,
    get_demo_assets_dir,
    get_demo_dataset_dir,
    get_demo_downloads_dir,
    get_demo_weights_dir,
    to_repo_relative_path,
)


LOT_PATH = ROOT_DIR / "demo" / "lot-definition.json"

DATASET_URL = "https://pub-e8bbdcbe8f6243b2a9933704a9b1d8bc.r2.dev/parking%2Frois_gopro.zip"
WEIGHTS_URL = "https://pub-e8bbdcbe8f6243b2a9933704a9b1d8bc.r2.dev/parking%2FRCNN_128_square_gopro.pt"


def main():
    assets_dir = get_demo_assets_dir()
    downloads_dir = get_demo_downloads_dir()
    dataset_dir = get_demo_dataset_dir()
    weights_dir = get_demo_weights_dir()
    downloads_dir.mkdir(parents=True, exist_ok=True)
    weights_dir.mkdir(parents=True, exist_ok=True)
    dataset_zip_path = downloads_dir / "rois_gopro.zip"
    weights_path = weights_dir / "RCNN_128_square_gopro.pt"

    download(DATASET_URL, dataset_zip_path)
    download(WEIGHTS_URL, weights_path)
    extract_dataset(dataset_zip_path, dataset_dir)

    annotations_path = next(dataset_dir.rglob("annotations.json"))
    annotations = json.loads(annotations_path.read_text(encoding="utf-8"))
    entries = flatten_annotations(annotations)
    lot_key, lot_entries = select_lot_sequence(entries)

    lot_entries = sorted(lot_entries, key=lambda item: item["file_name"])
    sample_entries = take_evenly_spaced(lot_entries, count=min(6, len(lot_entries)))
    roi_template = sample_entries[0]["rois"]
    rows = infer_rows(roi_template)
    levels, slots = build_slots(roi_template, rows)
    primary_camera = {
        "id": "CAM-ACPDS-01",
        "name": "ACPDS Overlook 01",
        "levelId": levels[0]["id"],
        "location": f"Derived from {lot_key}",
        "angle": "calibrated demo view",
    }
    frames = []
    for index, entry in enumerate(sample_entries):
        image_path = resolve_image_path(dataset_dir, entry["file_name"])
        width, height = image_dimensions(image_path)
        frames.append(
            {
                "id": f"frame-{str(index + 1).zfill(2)}",
                "cameraId": primary_camera["id"],
                "label": Path(entry["file_name"]).stem,
                "imagePath": to_repo_relative_path(image_path),
                "capturedAt": f"2026-03-13T09:00:{str(index * 5).zfill(2)}.000Z",
                "width": width,
                "height": height,
            }
        )

    lot_definition = {
        "facilityId": "acpds-demo",
        "facilityName": f"ACPDS {lot_key}",
        "timeZone": "Europe/Rome",
        "levelId": levels[0]["id"],
        "levelName": levels[0]["name"],
        "levels": levels,
        "sourceLotKey": lot_key,
        "camera": primary_camera,
        "cameras": [primary_camera],
        "frames": frames,
        "slots": slots,
    }
    preserve_existing_demo_extensions(lot_definition)

    LOT_PATH.parent.mkdir(parents=True, exist_ok=True)
    LOT_PATH.write_text(json.dumps(lot_definition, indent=2), encoding="utf-8")

    print(f"Assets directory: {assets_dir}")
    print(f"Override with {DEMO_ASSETS_ENV_VAR}=...")
    print(f"Selected lot: {lot_key}")
    print(f"Frames: {len(lot_definition['frames'])}")
    print(f"Slots: {len(lot_definition['slots'])}")
    print(f"Wrote {LOT_PATH}")


def download(url: str, destination: Path):
    if destination.exists():
        print(f"Using cached {destination.name}")
        return

    response = requests.get(url, timeout=300)
    response.raise_for_status()
    destination.write_bytes(response.content)
    print(f"Downloaded {destination.name}")


def extract_dataset(archive_path: Path, destination: Path):
    marker = destination / ".extracted"
    if marker.exists():
        print(f"Using extracted dataset in {destination}")
        return

    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive_path) as archive:
        archive.extractall(destination)
    marker.write_text("ok", encoding="utf-8")
    print(f"Extracted dataset to {destination}")


def flatten_annotations(annotations: dict) -> list[dict]:
    entries = []
    for split_name in ("train", "valid", "test"):
        split = annotations[split_name]
        for file_name, rois, occupancy in zip(
            split["file_names"],
            split["rois_list"],
            split["occupancy_list"],
            strict=True,
        ):
            entries.append(
                {
                    "split": split_name,
                    "file_name": file_name,
                    "rois": rois,
                    "occupancy": occupancy,
                }
            )
    return entries


def select_lot_sequence(entries: list[dict]) -> tuple[str, list[dict]]:
    normalized = []
    for entry in entries:
        frame_number = int(re.search(r"(\d+)", Path(entry["file_name"]).stem).group(1))
        normalized.append(
            {
                **entry,
                "frame_number": frame_number,
            }
        )

    normalized.sort(key=lambda item: item["frame_number"])
    clusters: list[list[dict]] = []
    current = [normalized[0]]

    for entry in normalized[1:]:
        previous = current[-1]
        gap = entry["frame_number"] - previous["frame_number"]
        roi_delta = abs(len(entry["rois"]) - len(previous["rois"]))

        if gap <= 2 and roi_delta <= 3:
            current.append(entry)
        else:
            clusters.append(current)
            current = [entry]

    clusters.append(current)
    clusters = [cluster for cluster in clusters if len(cluster) >= 2]

    if not clusters:
        raise RuntimeError("Unable to infer a stable lot sequence from ACPDS annotations")

    clusters.sort(key=lambda cluster: (len(cluster), -cluster[0]["frame_number"]), reverse=True)
    selected = clusters[0]
    start = selected[0]["frame_number"]
    end = selected[-1]["frame_number"]
    key = f"lot-{start}-{end}"
    print(f"Selected contiguous sequence {key} with {len(selected)} frames")
    return key, selected


def preserve_existing_demo_extensions(lot_definition: dict) -> None:
    if not LOT_PATH.exists():
        return

    try:
        existing = json.loads(LOT_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return

    primary_camera_id = lot_definition["camera"]["id"]
    current_level_ids = {level["id"] for level in lot_definition["levels"]}
    extra_cameras = [
        camera
        for camera in existing.get("cameras", [])
        if camera.get("id") != primary_camera_id
    ]
    extra_camera_ids = {camera["id"] for camera in extra_cameras}
    extra_frames = [
        frame
        for frame in existing.get("frames", [])
        if frame.get("cameraId") in extra_camera_ids
    ]
    extra_slots = [
        slot
        for slot in existing.get("slots", [])
        if slot.get("cameraId") in extra_camera_ids
    ]
    extra_level_ids = {slot["levelId"] for slot in extra_slots}
    extra_levels = [
        level
        for level in existing.get("levels", [])
        if level.get("id") in extra_level_ids and level.get("id") not in current_level_ids
    ]

    if extra_levels:
        lot_definition["levels"].extend(extra_levels)
        lot_definition["levels"].sort(key=lambda level: level["index"])
    if extra_cameras:
        lot_definition["cameras"].extend(extra_cameras)
    if extra_frames:
        lot_definition["frames"].extend(extra_frames)
    if extra_slots:
        lot_definition["slots"].extend(extra_slots)


def consistent_roi_count(entries: list[dict]) -> bool:
    return len({len(entry["rois"]) for entry in entries}) == 1


def take_evenly_spaced(entries: list[dict], count: int) -> list[dict]:
    if len(entries) <= count:
        return entries

    step = (len(entries) - 1) / (count - 1)
    return [entries[round(index * step)] for index in range(count)]


def infer_rows(rois: list[list[list[float]]]) -> list[int]:
    centers = [(index, sum(point[1] for point in roi) / len(roi)) for index, roi in enumerate(rois)]
    sorted_centers = sorted(centers, key=lambda item: item[1])
    rows: list[list[int]] = []
    threshold = 0.08

    for index, center_y in sorted_centers:
        if not rows or abs(center_y - row_mean(rows[-1], centers)) > threshold:
            rows.append([index])
        else:
            rows[-1].append(index)

    row_lookup = {}
    for row_index, row in enumerate(rows):
        for slot_index in row:
            row_lookup[slot_index] = row_index

    return [row_lookup[index] for index in range(len(rois))]


def row_mean(row: list[int], centers: list[tuple[int, float]]) -> float:
    center_lookup = dict(centers)
    return sum(center_lookup[index] for index in row) / len(row)


def build_slots(rois: list[list[list[float]]], rows: list[int]) -> tuple[list[dict], list[dict]]:
    grouped: dict[int, list[tuple[int, list[list[float]]]]] = {}
    for index, roi in enumerate(rois):
        grouped.setdefault(rows[index], []).append((index, roi))

    levels = [
        {
            "id": f"PLANE-{str(group_index + 1).zfill(2)}",
            "name": f"Plane {str(group_index + 1).zfill(2)}",
            "index": group_index,
            "gridRows": 1,
            "gridColumns": 1,
        }
        for group_index, _ in enumerate(sorted(grouped))
    ]
    level_lookup = {
        row_index: levels[group_index]["id"]
        for group_index, row_index in enumerate(sorted(grouped))
    }
    row_col_lookup: dict[int, tuple[int, int, str]] = {}
    for row_index, row_items in grouped.items():
        row_items.sort(key=lambda item: sum(point[0] for point in item[1]) / len(item[1]))
        for col_index, (slot_index, _) in enumerate(row_items):
            row_col_lookup[slot_index] = (0, col_index, level_lookup[row_index])

    max_columns = max(col for _, col, _ in row_col_lookup.values()) + 1
    total_rows = len(levels)
    slots_per_level: dict[str, int] = {}

    slots = []
    for slot_index, roi in enumerate(rois):
        row, column, level_id = row_col_lookup[slot_index]
        slots_per_level[level_id] = max(slots_per_level.get(level_id, 0), column + 1)
        center_x = 0.14 + column * 0.18
        center_y = 0.45
        layout_polygon = rectangle_polygon(center_x, center_y, 0.12, 0.18)
        slots.append(
            {
                "id": f"B{str(slot_index + 1).zfill(2)}",
                "label": f"Bay {str(slot_index + 1).zfill(2)}",
                "row": row,
                "column": column,
                "levelId": level_id,
                "cameraId": "CAM-ACPDS-01",
                "imagePolygon": [[round(point[0], 4), round(point[1], 4)] for point in roi],
                "layoutPolygon": layout_polygon,
                "evCapable": slot_index % max(3, max_columns) == 2,
                "reservedDefault": slot_index == max_columns,
            }
        )

    for level in levels:
        level["gridColumns"] = slots_per_level.get(level["id"], 1)

    print(f"Inferred {total_rows} matrix planes and {max_columns} columns")
    return levels, slots


def rectangle_polygon(center_x: float, center_y: float, width: float, height: float) -> list[list[float]]:
    half_width = width / 2
    half_height = height / 2
    return [
        [round(center_x - half_width, 4), round(center_y - half_height, 4)],
        [round(center_x + half_width, 4), round(center_y - half_height, 4)],
        [round(center_x + half_width, 4), round(center_y + half_height, 4)],
        [round(center_x - half_width, 4), round(center_y + half_height, 4)],
    ]


def resolve_image_path(dataset_dir: Path, file_name: str) -> Path:
    direct = dataset_dir / file_name
    if direct.exists():
        return direct

    images_dir = dataset_dir / "images" / file_name
    if images_dir.exists():
        return images_dir

    matches = list(dataset_dir.rglob(Path(file_name).name))
    if not matches:
        raise FileNotFoundError(f"Unable to locate image {file_name} in {dataset_dir}")

    return matches[0]


def image_dimensions(image_path: Path) -> tuple[int, int]:
    with Image.open(image_path) as image:
        return image.size


if __name__ == "__main__":
    main()
