from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Mapping


@dataclass(frozen=True)
class ConsistencyIssue:
    code: str
    severity: str
    message: str
    scope: str
    observed_at: str


def find_state_inconsistencies(
    zone_states: Mapping[str, Mapping[str, float | int]],
    *,
    observed_at: str | None = None,
    max_state_age_seconds: float | None = None,
    state_age_seconds: float | None = None,
) -> list[ConsistencyIssue]:
    observed_at = observed_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    issues: list[ConsistencyIssue] = []

    for zone_id, state in zone_states.items():
        total = int(state.get("totalBays", 0))
        occupied = int(state.get("occupiedBays", 0))
        available = int(state.get("availableBays", 0))

        if total < 0:
            issues.append(
                ConsistencyIssue(
                    code="negative_total",
                    severity="critical",
                    message=f"{zone_id} reported a negative total bay count",
                    scope=zone_id,
                    observed_at=observed_at,
                )
            )

        if occupied > total:
            issues.append(
                ConsistencyIssue(
                    code="occupied_exceeds_total",
                    severity="critical",
                    message=f"{zone_id} occupied bays exceed total bays",
                    scope=zone_id,
                    observed_at=observed_at,
                )
            )

        if available < 0:
            issues.append(
                ConsistencyIssue(
                    code="negative_available",
                    severity="critical",
                    message=f"{zone_id} reported a negative available bay count",
                    scope=zone_id,
                    observed_at=observed_at,
                )
            )

        if total >= 0 and occupied + available != total:
            issues.append(
                ConsistencyIssue(
                    code="bay_totals_mismatch",
                    severity="warning",
                    message=f"{zone_id} bay totals do not reconcile",
                    scope=zone_id,
                    observed_at=observed_at,
                )
            )

    if max_state_age_seconds is not None and state_age_seconds is not None:
        if state_age_seconds > max_state_age_seconds:
            issues.append(
                ConsistencyIssue(
                    code="stale_state",
                    severity="warning",
                    message="Live state snapshot is stale",
                    scope="global",
                    observed_at=observed_at,
                )
            )

    return issues


def serialize_consistency_issues(issues: list[ConsistencyIssue]) -> list[dict[str, object]]:
    return [asdict(issue) for issue in issues]
