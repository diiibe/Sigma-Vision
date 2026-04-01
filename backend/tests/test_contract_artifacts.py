from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]
SCHEMA_PATH = ROOT_DIR / "contracts" / "parking-runtime.schema.json"


class ContractArtifactsTest(unittest.TestCase):
    def test_contract_schema_exposes_the_required_definitions(self):
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

        defs = schema["$defs"]
        required_contracts = {
            "SpatialConfig",
            "DetectionRecord",
            "TrackRecord",
            "BayState",
            "ZoneKpiState",
            "FlowEvent",
            "AlertEvent",
            "TimelinePoint",
            "ModuleHealth",
            "LiveStateSnapshot",
        }

        self.assertTrue(required_contracts.issubset(defs.keys()))
        self.assertEqual(schema["x-contracts"], [
            "SpatialConfig",
            "DetectionRecord",
            "TrackRecord",
            "BayState",
            "ZoneKpiState",
            "FlowEvent",
            "AlertEvent",
            "TimelinePoint",
            "ModuleHealth",
            "LiveStateSnapshot",
        ])

    def test_spatial_config_and_live_state_contracts_include_key_fields(self):
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

        spatial_config = schema["$defs"]["SpatialConfig"]
        live_state = schema["$defs"]["LiveStateSnapshot"]

        self.assertIn("bayZoneMemberships", spatial_config["required"])
        self.assertIn("entryLines", spatial_config["required"])
        self.assertIn("exitLines", spatial_config["required"])
        self.assertIn("timeline", live_state["required"])
        self.assertIn("moduleHealth", live_state["required"])


if __name__ == "__main__":
    unittest.main()
