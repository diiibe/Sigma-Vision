from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from collections import defaultdict
from typing import Iterable


@dataclass(frozen=True)
class TimelinePoint:
    bucket_start: str
    metric_name: str
    scope: str
    value: float
    window_seconds: int
    source: str | None = None


def parse_timestamp(timestamp: str | datetime) -> datetime:
    if isinstance(timestamp, datetime):
        value = timestamp
    else:
        value = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))

    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)

    return value.astimezone(timezone.utc)


def bucket_timestamp(timestamp: str | datetime, bucket_seconds: int) -> str:
    if bucket_seconds <= 0:
        raise ValueError("bucket_seconds must be positive")

    parsed = parse_timestamp(timestamp)
    epoch = int(parsed.timestamp())
    floored = epoch - (epoch % bucket_seconds)
    return datetime.fromtimestamp(floored, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def rollup_timeline_points(
    points: Iterable[TimelinePoint],
    bucket_seconds: int,
) -> list[TimelinePoint]:
    buckets: dict[tuple[str, str, str, int], float] = defaultdict(float)
    source_by_key: dict[tuple[str, str, str, int], str | None] = {}

    for point in points:
        bucket_start = bucket_timestamp(point.bucket_start, bucket_seconds)
        key = (bucket_start, point.metric_name, point.scope, point.window_seconds)
        buckets[key] += point.value
        if key not in source_by_key:
            source_by_key[key] = point.source

    return [
        TimelinePoint(
            bucket_start=bucket_start,
            metric_name=metric_name,
            scope=scope,
            value=value,
            window_seconds=window_seconds,
            source=source_by_key[(bucket_start, metric_name, scope, window_seconds)],
        )
        for (bucket_start, metric_name, scope, window_seconds), value in sorted(buckets.items())
    ]


def serialize_timeline_points(points: Iterable[TimelinePoint]) -> list[dict[str, object]]:
    return [asdict(point) for point in points]
