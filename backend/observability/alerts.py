from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Mapping


@dataclass(frozen=True)
class ThresholdRule:
    rule_id: str
    source_kpi: str
    comparator: str
    threshold_value: float
    severity: str
    explanation_template: str


@dataclass(frozen=True)
class AlertEvaluation:
    alert_id: str
    source_kpi: str
    threshold_rule: str
    severity: str
    active: bool
    first_seen: str
    last_evaluated: str
    explanation_text: str
    current_value: float
    threshold_value: float


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def evaluate_threshold_rule(
    rule: ThresholdRule,
    observed_value: float,
    observed_at: str | None = None,
) -> AlertEvaluation:
    observed_at = observed_at or _utc_now()
    active = _matches(rule.comparator, observed_value, rule.threshold_value)
    explanation = rule.explanation_template.format(
        source_kpi=rule.source_kpi,
        value=observed_value,
        threshold=rule.threshold_value,
    )

    return AlertEvaluation(
        alert_id=f"alert:{rule.rule_id}:{observed_at}",
        source_kpi=rule.source_kpi,
        threshold_rule=rule.rule_id,
        severity=rule.severity,
        active=active,
        first_seen=observed_at,
        last_evaluated=observed_at,
        explanation_text=explanation,
        current_value=observed_value,
        threshold_value=rule.threshold_value,
    )


def evaluate_alerts(
    rules: list[ThresholdRule],
    observations: Mapping[str, float],
    observed_at: str | None = None,
) -> list[AlertEvaluation]:
    results: list[AlertEvaluation] = []
    for rule in rules:
        if rule.source_kpi not in observations:
            continue
        results.append(evaluate_threshold_rule(rule, observations[rule.source_kpi], observed_at))
    return results


def _matches(comparator: str, observed_value: float, threshold_value: float) -> bool:
    if comparator == "gt":
        return observed_value > threshold_value
    if comparator == "gte":
        return observed_value >= threshold_value
    if comparator == "lt":
        return observed_value < threshold_value
    if comparator == "lte":
        return observed_value <= threshold_value
    raise ValueError(f"Unsupported comparator: {comparator}")


def serialize_alert_evaluations(alerts: list[AlertEvaluation]) -> list[dict[str, object]]:
    return [asdict(alert) for alert in alerts]
