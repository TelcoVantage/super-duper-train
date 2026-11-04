#!/usr/bin/env python3
"""
Structural checks for scripts/Reply-Watch.script (the GUI-importable agent
script). They mirror what the Genesys import validates first: every {{id}}
reference points at a declared variable, every action reference points at a
declared custom action, the start page exists, and the file is the exact
output of the generator (so nobody edits the JSON by hand and forgets the
generator).

    python3 test/test_reply_watch_script.py
"""
import importlib.util
import json
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT_FILE = ROOT / "scripts" / "Reply-Watch.script"
GENERATOR = ROOT / "scripts" / "build_reply_watch_script.py"
REF = re.compile(r"\{\{([0-9a-f-]{36})\}\}")
KNOWN_COMPONENTS = {"verticalStackContainer", "horizontalStackContainer", "text", "button", "image", "webPage", "input"}
KNOWN_ACTIONS = {"scripter.refreshInputVariables", "scripter.alert", "scripter.setVariable", "scripter.changePage"}


def load_generated():
    spec = importlib.util.spec_from_file_location("gen", GENERATOR)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.script


class ReplyWatchScriptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = json.loads(SCRIPT_FILE.read_text(encoding="utf-8"))
        cls.var_ids = {v["id"] for v in cls.doc["variables"]}
        cls.var_by_name = {v["name"]: v for v in cls.doc["variables"]}
        cls.action_ids = {a["id"] for a in cls.doc["customActions"]}

    def test_file_matches_generator_output(self):
        self.assertEqual(self.doc, load_generated(), "run python3 scripts/build_reply_watch_script.py")

    def test_top_level_shape(self):
        for key in ("id", "name", "versionId", "startPageId", "pages", "features", "variables", "customActions", "dataVersion"):
            self.assertIn(key, self.doc)
        self.assertEqual(self.doc["name"], "Reply Watch")
        self.assertIn(self.doc["startPageId"], {p["id"] for p in self.doc["pages"]})
        self.assertTrue(self.doc["features"]["message"]["properties"]["enabled"]["value"], "script must be enabled for message interactions")
        self.assertTrue(self.doc["features"]["scripter"]["properties"]["enabled"]["value"])

    def test_variables_are_inputs_matching_the_workflow_attributes(self):
        expected = {"rw_status", "rw_level", "rw_critical", "rw_warning", "rw_since", "rw_updated"}
        self.assertEqual(set(self.var_by_name), expected)
        for v in self.doc["variables"]:
            self.assertTrue(v["input"], v["name"])
            self.assertFalse(v["output"], v["name"])
            self.assertFalse(v["type"]["isDynamic"], v["name"])
        self.assertEqual(self.var_by_name["rw_critical"]["type"]["name"], "boolean")
        self.assertEqual(self.var_by_name["rw_warning"]["type"]["name"], "boolean")
        # the data action must write every attribute the script reads
        da = json.loads((ROOT / "data-actions" / "Set-Watchdog-Status.json").read_text())
        body = da["config"]["request"]["requestTemplate"]
        for name in expected:
            self.assertIn(f'"{name}"', body, f"data action does not write {name}")

    def test_every_reference_resolves(self):
        raw = SCRIPT_FILE.read_text(encoding="utf-8")
        for ref in REF.findall(raw):
            self.assertIn(ref, self.var_ids, f"unresolved variable reference {ref}")

        def walk(node):
            if isinstance(node, dict):
                if isinstance(node.get("type"), str) and "properties" in node:
                    self.assertIn(node["type"], KNOWN_COMPONENTS, node["type"])
                    vis = node["properties"].get("visible", {})
                    if "value" in vis:
                        self.assertIn(vis["value"], self.var_ids, "visible bound to unknown variable")
                    click = node["properties"].get("clickAction", {}).get("value", {})
                    if click.get("actionName"):
                        self.assertIn(click["actionName"], self.action_ids | KNOWN_ACTIONS)
                if node.get("type") == "action":
                    self.assertIn(node["actionName"], self.action_ids | KNOWN_ACTIONS, node["actionName"])
                for v in node.values():
                    walk(v)
            elif isinstance(node, list):
                for v in node:
                    walk(v)

        walk(self.doc)
        for page in self.doc["pages"]:
            on_load = page["properties"]["onLoadAction"]["value"].get("actionName")
            if on_load:
                self.assertIn(on_load, self.action_ids)

    def test_check_action_refreshes_then_alerts_only_when_critical(self):
        action = self.doc["customActions"][0]["action"]["block"]
        self.assertEqual(action[0]["actionName"], "scripter.refreshInputVariables")
        cond = action[1]
        self.assertEqual(cond["type"], "if")
        self.assertEqual(cond["condition"]["leftHandSide"]["value"], self.var_by_name["rw_level"]["id"])
        self.assertEqual(cond["condition"]["rightHandSide"]["value"], "2")
        self.assertEqual(cond["ifBlock"][0]["actionName"], "scripter.alert")
        self.assertEqual(cond["elseBlock"], [])

    def test_banners_bound_to_the_right_flags(self):
        children = self.doc["pages"][0]["rootContainer"]["children"]
        red, amber = children[0], children[1]
        self.assertEqual(red["properties"]["visible"]["value"], self.var_by_name["rw_critical"]["id"])
        self.assertEqual(amber["properties"]["visible"]["value"], self.var_by_name["rw_warning"]["id"])
        self.assertEqual(red["properties"]["backgroundColor"]["value"], "#d93025")
        button = next(c for c in children if c["type"] == "button")
        self.assertEqual(button["properties"]["clickAction"]["value"]["actionName"], self.doc["customActions"][0]["id"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
