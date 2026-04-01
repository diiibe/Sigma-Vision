from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any


def configure_structured_logging(level: int = logging.INFO) -> None:
    logging.basicConfig(
        level=level,
        format="%(message)s",
    )


def log_event(logger: logging.Logger, event: str, **fields: Any) -> None:
    payload = {
        "event": event,
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        **fields,
    }
    logger.info(json.dumps(payload, sort_keys=True))
