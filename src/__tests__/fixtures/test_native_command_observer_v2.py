"""Synthetic fixture controls. No historical/private records or execution ports."""
import json
import unittest
from native_command_observer_v2 import MAX_RECORDS, observe


class ObserverTests(unittest.TestCase):
    def test_function_call_positive_control(self):
        result = observe([{"type": "response_item", "payload": {
            "type": "function_call", "name": "exec_command"}, "designated_match": True}])
        self.assertEqual(result["counts"]["rollout_function_call"], 1)
        self.assertEqual(result["command_match"], "TRUE")

    def test_native_and_projected_interfaces_are_separate(self):
        records = [
            {"interface": "sdk", "type": "item.started", "item": {"type": "command_execution"}},
            {"interface": "sdk", "type": "item.completed", "item": {"type": "command_execution"}},
            {"interface": "app_server", "method": "item/started", "params": {"item": {"type": "commandExecution"}}},
            {"interface": "app_server_projected", "type": "item.completed", "item": {"type": "command_execution"}},
        ]
        result = observe(records)
        self.assertEqual(result["counts"], {"rollout_function_call": 0, "sdk_native": 2,
                                          "app_server_native": 1, "app_server_projected": 1})
        self.assertEqual(result["phases"], {"started": 2, "completed": 2})
        self.assertEqual(result["command_match"], "UNOBSERVED")

    def test_empty_and_uncovered_are_unobserved(self):
        for records in ([], [{"type": "custom_tool_call"}], [{"type": "item.completed", "item": {"type": "command_execution"}}]):
            self.assertEqual(observe(records)["command_match"], "UNOBSERVED")

    def test_match_requires_safe_fact_and_cannot_be_inferred_from_arguments(self):
        base = {"interface": "sdk", "type": "item.completed", "item": {
            "type": "command_execution", "command": "ARG_CANARY", "aggregated_output": "OUTPUT_CANARY"}}
        self.assertEqual(observe([base])["command_match"], "UNOBSERVED")
        self.assertEqual(observe([{**base, "designated_match": False}])["command_match"], "FALSE")
        self.assertEqual(observe([{**base, "designated_match": True}, base])["command_match"], "UNOBSERVED")
        self.assertNotIn("CANARY", json.dumps(observe([base])))

    def test_bounded_coverage_never_claims_complete_match(self):
        row = {"type": "response_item", "payload": {"type": "function_call", "name": "shell"}, "designated_match": True}
        result = observe([row] * (MAX_RECORDS + 1))
        self.assertTrue(result["limited"])
        self.assertEqual(result["counts"]["rollout_function_call"], MAX_RECORDS)
        self.assertEqual(result["command_match"], "UNOBSERVED")
        self.assertLessEqual(len(json.dumps(result)), 512)

    def test_malformed_metadata_is_not_evidence(self):
        for row in (None, [], 1, {"payload": None}, {"interface": "sdk", "item": None}):
            self.assertEqual(observe([row])["command_match"], "UNOBSERVED")


if __name__ == "__main__":
    unittest.main()
