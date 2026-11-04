#!/usr/bin/env python3
"""
Structural checks for workflow/Unanswered-Message-Watchdog.i3WorkFlow, the
Architect import file. The file is base64(encodeURIComponent(JSON)); the
checks decode it the same way Architect does and verify the things an import
validates first: the action graph is closed, every variable/data-action
reference resolves, expression positions point at the right tokens, data
action inputs/outputs match the published contracts, and the file is exactly
what the generator produces.

    python3 test/test_i3workflow.py
"""
import base64
import importlib.util
import json
import pathlib
import unittest
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parents[1]
FILE = ROOT / "workflow" / "Unanswered-Message-Watchdog.i3WorkFlow"
GEN = ROOT / "workflow" / "build_i3workflow.py"


def decode(blob):
    return json.loads(urllib.parse.unquote(base64.b64decode(blob).decode("ascii")))


def load_generator():
    spec = importlib.util.spec_from_file_location("gen", GEN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def walk_expressions(node, out):
    """Yields every expression value object ({config, text, type, uiMetaData...})."""
    if isinstance(node, dict):
        if "config" in node and "text" in node and "uiMetaData" in node:
            out.append(node)
        for v in node.values():
            walk_expressions(v, out)
    elif isinstance(node, list):
        for v in node:
            walk_expressions(v, out)


def leaves(tree, out):
    for key, body in tree.items():
        if key in ("ref", "lit", "emp", "nul"):
            out.append((key, body))
        else:
            for op in body.get("operands", []):
                leaves(op, out)


class I3WorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = decode(FILE.read_bytes())
        cls.state = cls.doc["flowSequenceItemList"][0]
        cls.actions = {a["id"]: a for a in cls.state["actionList"]}
        cls.vars = {v["id"]: v for v in cls.doc["variables"]}

    def test_file_matches_generator(self):
        gen = load_generator()
        self.assertEqual(self.doc, gen.build(), "run python3 workflow/build_i3workflow.py")
        self.assertEqual(FILE.read_text("ascii"), gen.encode(gen.build()))

    def test_top_level(self):
        self.assertEqual(self.doc["type"], "workflow")
        self.assertEqual(self.doc["name"], "Unanswered Message Watchdog")
        self.assertEqual(self.doc["initialSequence"], self.state["id"])
        self.assertEqual(self.doc["errorHandling"]["handlingType"], "EndWorkflow")
        ids = {a["trackingId"] for a in self.actions.values()} | {self.state["trackingId"]}
        self.assertEqual(len(ids), len(self.actions) + 1, "trackingIds must be unique")
        self.assertGreater(self.doc["nextTrackingNumber"], max(ids))
        self.assertEqual(len({v["name"] for v in self.vars.values()}), len(self.vars), "variable names unique")
        for name in ("Flow.conversationId", "Flow.userId", "Flow.participantId", "Flow.mediaType", "Flow.queueId"):
            v = next(v for v in self.vars.values() if v["name"] == name)
            self.assertTrue(v["isInput"], name)

    def test_action_graph_is_closed_and_reachable(self):
        self.assertIn(self.state["startAction"], self.actions)
        reachable = set()
        stack = [self.state["startAction"]]
        while stack:
            aid = stack.pop()
            if aid in reachable:
                continue
            reachable.add(aid)
            a = self.actions[aid]
            nxt = [a.get("nextAction")]
            for p in a.get("paths", []) + ([a["path"]] if "path" in a else []):
                nxt.append(p.get("nextActionId"))
            for n in nxt:
                if n:
                    self.assertIn(n, self.actions, f"{a['name']} points at unknown action {n}")
                    stack.append(n)
        self.assertEqual(reachable, set(self.actions), "every action must be reachable from the start")
        # every branch target is referenced exactly once (a real export never shares a node between branches)
        refs = []
        for a in self.actions.values():
            refs.append(a.get("nextAction"))
            for p in a.get("paths", []) + ([a["path"]] if "path" in a else []):
                refs.append(p.get("nextActionId"))
        refs = [r for r in refs if r]
        self.assertEqual(len(refs), len(set(refs)), "an action is linked from two places")

    def test_every_variable_reference_resolves_and_types_match(self):
        exprs = []
        walk_expressions(self.doc, exprs)
        self.assertGreater(len(exprs), 50)
        for e in exprs:
            lv = []
            leaves(e["config"], lv)
            for kind, body in lv:
                if kind == "ref":
                    self.assertIn(body["val"], self.vars, body["text"])
                    v = self.vars[body["val"]]
                    self.assertEqual(v["name"], body["text"])
                    self.assertEqual({"StringVariable": "str", "IntegerVariable": "int", "BoolVariable": "bln"}[v["__type"]], body["type"])
            for r in e.get("metaData", {}).get("references", []):
                self.assertIn(r["id"], self.vars)

    def test_expression_positions_point_at_their_tokens(self):
        exprs = []
        walk_expressions(self.doc, exprs)
        for e in exprs:
            if e["uiMetaData"]["mode"] != 0:
                continue
            text = e["text"]
            # Architect positions are 1-based UTF-16 code-unit offsets
            units = text.encode("utf-16-le")

            def at(pos):
                return units[(pos - 1) * 2:].decode("utf-16-le", errors="ignore")

            lv = []
            leaves(e["config"], lv)
            for kind, body in lv:
                if kind == "ref":
                    self.assertTrue(at(body["pos"]).startswith(body["text"]), (text, body))
                elif kind == "lit" and body["type"] == "str":
                    self.assertTrue(at(body["pos"]).startswith('"' + body["text"]), (text, body))
                elif kind == "lit":
                    self.assertTrue(at(body["pos"]).startswith(body["text"]), (text, body))

            def ops(tree):
                for key, body in tree.items():
                    if key not in ("ref", "lit", "emp", "nul"):
                        self.assertTrue(at(body["pos"]).startswith(key), (text, key, body["pos"]))
                        for op in body.get("operands", []):
                            ops(op)

            ops(e["config"])

    def test_data_actions_match_published_contracts(self):
        contracts = {}
        for fn in ("Get-Message-Reply-State.json", "Set-Watchdog-Status.json", "Send-Agent-Chat-Message.json"):
            da = json.loads((ROOT / "data-actions" / fn).read_text())
            contracts[da["name"]] = da["contract"]
        manifest = {m["name"]: m for m in self.doc["manifest"]["dataAction"]}
        service = {s["name"]: s for s in self.doc["uiMetaData"]["actionServiceActions"]}
        self.assertEqual(set(manifest), set(contracts))
        self.assertEqual(set(service), set(contracts))
        used = {}
        for a in self.actions.values():
            if a["__type"] != "DataAction":
                continue
            c = contracts[a["actionName"]]
            self.assertEqual(a["actionId"], manifest[a["actionName"]]["id"])
            self.assertIn(a["id"], {x["id"] for x in manifest[a["actionName"]]["context"]})
            in_names = {i["name"] for i in a["inputs"]}
            self.assertTrue(set(c["input"]["inputSchema"].get("required", [])) <= in_names, a["name"])
            self.assertTrue(in_names <= set(c["input"]["inputSchema"]["properties"]), a["name"])
            out_names = {o["name"] for o in a["outputs"]}
            self.assertTrue(out_names <= set(c["output"]["successSchema"]["properties"]), a["name"])
            for o in a["outputs"]:
                self.assertEqual(o["value"]["uiMetaData"]["mode"], 2)
                self.assertIn(o["value"]["config"]["ref"]["val"], self.vars)
            used.setdefault(a["actionName"], 0)
            used[a["actionName"]] += 1
        self.assertEqual(used["Get Message Reply State"], 1)
        self.assertEqual(used["Send Agent Chat Message"], 2)
        self.assertEqual(used["Set Watchdog Status"], 3)

    def test_loop_and_wait(self):
        loop = next(a for a in self.actions.values() if a["__type"] == "LoopAction")
        wait = self.actions[loop["path"]["nextActionId"]]
        self.assertEqual(wait["__type"], "WaitAction")
        self.assertEqual(wait["duration"]["text"], "P0D0H0M20S0F")
        poll = next(v for v in self.vars.values() if v["name"] == "Flow.pollSeconds")
        self.assertEqual(poll["initialValue"]["text"], "20", "Flow.pollSeconds must equal the Wait duration")
        self.assertEqual(self.actions[loop["nextAction"]]["__type"], "EndWorkflowAction")
        exits = [a for a in self.actions.values() if a["__type"] == "ExitLoopAction"]
        self.assertEqual(len(exits), 3)


if __name__ == "__main__":
    unittest.main(verbosity=1)
