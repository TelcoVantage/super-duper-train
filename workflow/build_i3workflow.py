#!/usr/bin/env python3
"""
Generates workflow/Unanswered-Message-Watchdog.i3WorkFlow – the Architect
import format (Admin > Architect > Flows:Workflow > Add > Save menu > Import).

The .i3WorkFlow format is base64( encodeURIComponent( JSON ) ). The JSON is
Architect's internal flow document: a flat action list per task ("State"),
actions chained by id with branch "paths", and every expression stored both as
text and as a parsed tree with 1-based character positions. The shapes used
here were taken from published Genesys Cloud blueprint exports; the data
actions are referenced by NAME (Architect matches them on import) plus a
placeholder id.

    python3 workflow/build_i3workflow.py          # writes the .i3WorkFlow
    python3 workflow/build_i3workflow.py --json   # also writes a readable .json copy

Logic (same as docs/build-guide.md, but with the wait measured by counting
polls instead of date arithmetic, so the file needs no DateTime variables):

  initialise -> LOOP (maxPolls):
      wait pollSeconds
      Get Message Reply State  (failure/timeout: count, give up after N)
      me still connected?  no -> still ringing & grace left ? continue : EXIT
      customer waiting on me?
         no  -> if an alert was showing: write "Replied" status; reset counters
         yes -> waitedSeconds += pollSeconds (restarts on a new customer message)
                waited >= critical ? (first time or repeat due) -> status + chat
                waited >= warn     ? (first time)               -> status + chat
  END
"""
import base64
import json
import pathlib
import re
import sys
import urllib.parse
import uuid

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
NS = uuid.UUID("8c2d1c2a-6a1b-4d33-9b1a-2e4f3a8d9c01")


def uid(name):
    return str(uuid.uuid5(NS, name))


# ---------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------
TYPE_CODE = {"string": "str", "integer": "int", "boolean": "bln"}
VAR_TYPE = {"string": "StringVariable", "integer": "IntegerVariable", "boolean": "BoolVariable"}

# name, kind, initial (None = empty), isInput, description
VARIABLES = [
    ("Flow.conversationId", "string", None, True, "from trigger"),
    ("Flow.userId", "string", None, True, "from trigger (the agent)"),
    ("Flow.participantId", "string", None, True, "from trigger"),
    ("Flow.mediaType", "string", None, True, "from trigger"),
    ("Flow.queueId", "string", None, True, "from trigger"),
    ("Flow.warnAfterSeconds", "integer", 45, False, "first (soft) alert"),
    ("Flow.criticalAfterSeconds", "integer", 90, False, "escalated alert"),
    ("Flow.repeatEverySeconds", "integer", 60, False, "critical reminder interval, 0 = off"),
    ("Flow.pollSeconds", "integer", 20, False, "MUST equal the Wait action duration"),
    ("Flow.maxPolls", "integer", 1440, False, "hard stop: 1440 x 20 s = 8 h"),
    ("Flow.alertingGracePolls", "integer", 6, False, "polls to tolerate while still ringing"),
    ("Flow.maxConsecutiveFailures", "integer", 5, False, "give up when the API keeps failing"),
    ("Flow.level", "integer", 0, False, "0 none, 1 warned, 2 critical"),
    ("Flow.waitedSeconds", "integer", 0, False, ""),
    ("Flow.pollsSinceAlert", "integer", 0, False, ""),
    ("Flow.failures", "integer", 0, False, ""),
    ("Flow.graceLeft", "integer", 0, False, ""),
    ("Flow.pollIndex", "integer", 0, False, "loop index"),
    ("Flow.alertedFor", "string", "", False, ""),
    ("Flow.trackedSince", "string", "", False, ""),
    ("Flow.alertText", "string", "", False, ""),
    ("Flow.myConnected", "boolean", False, False, ""),
    ("Flow.myAlerting", "boolean", False, False, ""),
    # outputs of "Get Message Reply State"
    ("Flow.awaitingReply", "boolean", False, False, "data action output"),
    ("Flow.anyAgentConnected", "boolean", False, False, "data action output"),
    ("Flow.customerConnected", "boolean", False, False, "data action output"),
    ("Flow.waitingSince", "string", "", False, "data action output"),
    ("Flow.lastInboundTime", "string", "", False, "data action output"),
    ("Flow.lastOutboundTime", "string", "", False, "data action output"),
    ("Flow.agentConnectedTime", "string", "", False, "data action output"),
    ("Flow.agentStates", "string", "", False, "data action output"),
    ("Flow.agentNames", "string", "", False, "data action output"),
    ("Flow.customerName", "string", "", False, "data action output"),
    ("Flow.customerParticipantId", "string", "", False, "data action output"),
    ("Flow.channel", "string", "", False, "data action output"),
]
VAR = {name: {"id": uid("var:" + name), "kind": kind, "type": TYPE_CODE[kind]} for name, kind, *_ in VARIABLES}


# ---------------------------------------------------------------------------
# Expression parser -> Architect expression tree
# ---------------------------------------------------------------------------
FUNC_TYPES = {
    "Find": "int", "Append": "str", "ToString": "str", "GetCurrentDateTimeUtc": "dtm",
    "ToDateTime": "dtm", "AddSeconds": "dtm", "AddMinutes": "dtm", "Length": "int",
}
TOKEN = re.compile(r'\s*(?:(\d+)|("(?:[^"\\]|\\.)*")|([A-Za-z_][A-Za-z0-9_.]*)|(==|!=|<=|>=|[-+*<>(),]))')


class Parser:
    """Tiny recursive-descent parser for the Architect expression subset used here."""

    def __init__(self, text):
        self.text = text
        self.toks = []
        pos = 0
        while pos < len(text):
            m = TOKEN.match(text, pos)
            if not m or m.end() == pos:
                if text[pos:].strip() == "":
                    break
                raise SyntaxError(f"cannot tokenise {text!r} at {pos}")
            start = m.start(1) if m.group(1) else m.start(2) if m.group(2) else m.start(3) if m.group(3) else m.start(4)
            # Architect counts positions in UTF-16 code units (JavaScript), 1-based.
            utf16 = len(text[:start].encode("utf-16-le")) // 2 + 1
            self.toks.append((m.group(0).strip(), utf16))
            pos = m.end()
        self.i = 0
        self.refs = {}

    def peek(self):
        return self.toks[self.i][0] if self.i < len(self.toks) else None

    def take(self, expected=None):
        tok, pos = self.toks[self.i]
        if expected is not None and tok != expected:
            raise SyntaxError(f"expected {expected!r} got {tok!r} in {self.text!r}")
        self.i += 1
        return tok, pos

    def parse(self):
        node = self.p_or()
        if self.i != len(self.toks):
            raise SyntaxError(f"trailing tokens in {self.text!r}")
        return node

    def binary(self, nxt, ops, out_type):
        left = nxt()
        while self.peek() in ops:
            op, pos = self.take()
            right = nxt()
            t = out_type or left["type"]
            left = {"op": op, "pos": pos, "operands": [left, right], "type": t}
        return left

    def p_or(self):
        return self.binary(self.p_and, ("or",), "bln")

    def p_and(self):
        return self.binary(self.p_cmp, ("and",), "bln")

    def p_cmp(self):
        return self.binary(self.p_add, ("==", "!=", "<", "<=", ">", ">="), "bln")

    def p_add(self):
        return self.binary(self.p_mul, ("+", "-"), None)

    def p_mul(self):
        return self.binary(self.p_primary, ("*",), None)

    def p_primary(self):
        tok, pos = self.take()
        if tok == "(":
            node = self.p_or()
            self.take(")")
            return node
        if tok.isdigit():
            return {"lit": tok, "pos": pos, "type": "int"}
        if tok.startswith('"'):
            return {"lit": json.loads(tok), "pos": pos, "type": "str"}
        if tok in ("true", "false"):
            return {"lit": tok, "pos": pos, "type": "bln"}
        if self.peek() == "(":
            self.take("(")
            args = []
            if self.peek() != ")":
                args.append(self.p_or())
                while self.peek() == ",":
                    self.take(",")
                    args.append(self.p_or())
            self.take(")")
            if tok not in FUNC_TYPES:
                raise SyntaxError(f"unknown function {tok}")
            t = FUNC_TYPES[tok] if tok != "If" else args[1]["type"]
            return {"func": tok, "pos": pos, "operands": args, "type": t}
        if tok == "If":
            raise SyntaxError("If needs parentheses")
        if tok not in VAR:
            raise SyntaxError(f"unknown variable {tok} in {self.text!r}")
        self.refs[tok] = VAR[tok]
        return {"ref": tok, "pos": pos, "type": VAR[tok]["type"]}


FUNC_TYPES["If"] = None  # resolved from operands


def to_tree(node, root_text=None):
    if "ref" in node:
        return {"ref": {"pos": node["pos"], "text": node["ref"], "type": node["type"], "val": VAR[node["ref"]]["id"]}}
    if "lit" in node:
        return {"lit": {"pos": node["pos"], "text": str(node["lit"]), "type": node["type"]}}
    key = node.get("func") or node["op"]
    body = {"pos": node["pos"]}
    if root_text is not None:
        body["text"] = root_text
    body["operands"] = [to_tree(o) for o in node["operands"]]
    body["type"] = node["type"]
    return {key: body}


def expr(text, mode=0):
    """An expression value (mode 0 = expression) parsed from Architect syntax."""
    p = Parser(text)
    node = p.parse()
    refs = [{"id": v["id"], "type": v["type"], "isSysRef": False, "name": n} for n, v in p.refs.items()]
    return {"config": to_tree(node, text), "text": text, "type": node["type"], "uiMetaData": {"mode": mode},
            "metaData": {"references": refs} if refs else {}, "version": 2}


def lit(value, kind):
    if kind == "bln":
        text = "true" if value else "false"
    else:
        text = str(value)
    return {"config": {"lit": {"pos": 1, "text": text, "type": kind}}, "text": text, "type": kind,
            "uiMetaData": {"mode": 1}, "metaData": {}, "version": 2}


def empty(kind):
    return {"config": {"emp": {"pos": 1, "text": "", "type": kind}}, "text": "", "type": kind,
            "uiMetaData": {"mode": 3}, "metaData": {}, "version": 2}


def varref(name):
    v = VAR[name]
    return {"config": {"ref": {"pos": 1, "text": name, "type": v["type"], "val": v["id"]}}, "text": name, "type": v["type"],
            "uiMetaData": {"mode": 2}, "metaData": {"references": [{"id": v["id"], "type": v["type"], "isSysRef": False, "name": name}]},
            "version": 2}


def variable_def(name, kind, initial, is_input):
    code = TYPE_CODE[kind]
    return {
        "id": VAR[name]["id"], "isCollection": False, "isInternal": False, "isOutput": False, "isInput": is_input,
        "isSecure": False, "version": "1.0", "__type": VAR_TYPE[kind], "name": name,
        "initialValue": empty(code) if initial is None else lit(initial, code),
    }


# ---------------------------------------------------------------------------
# Data actions (names must match data-actions/*.json; ids are placeholders)
# ---------------------------------------------------------------------------
CATEGORY = "Genesys Cloud Data Actions"
ERROR_SCHEMA = json.loads((HERE / "i3workflow" / "errorbody.schema.json").read_text())
ERROR_BINDINGS = json.loads((HERE / "i3workflow" / "error-bindings.json").read_text())


def load_contract(filename):
    da = json.loads((ROOT / "data-actions" / filename).read_text())
    inp = da["contract"]["input"]["inputSchema"]
    out = da["contract"]["output"]["successSchema"]
    return da["name"], inp, out


DATA_ACTIONS = {}
for fn in ("Get-Message-Reply-State.json", "Set-Watchdog-Status.json", "Send-Agent-Chat-Message.json"):
    name, inp, out = load_contract(fn)
    DATA_ACTIONS[name] = {"id": "custom_-_" + uid("dataaction:" + name), "name": name, "input": inp, "output": out}


def flattened(schema):
    props = {k: {"type": v["type"], "name": k, "required": k in (schema.get("required") or [])} for k, v in schema.get("properties", {}).items()}
    return {"type": "object", "properties": props, "additionalProperties": True}


def service_action_entry(da):
    i, o = flattened(da["input"]), flattened(da["output"])
    return {
        "id": da["id"], "name": da["name"], "category": CATEGORY,
        "contract": {"input": {"inputSchemaFlattened": {"schema": i}},
                     "output": {"errorSchemaFlattened": {"schema": ERROR_SCHEMA}, "successSchemaFlattened": {"schema": o}}},
        "result": "ok", "inputSchema": i, "successSchema": o, "errorSchema": ERROR_SCHEMA,
    }


# ---------------------------------------------------------------------------
# Action builders (flat list + id chaining, like a real export)
# ---------------------------------------------------------------------------
class Flow:
    def __init__(self):
        self.actions = []
        self.tracking = 10

    def _base(self, kind, name):
        self.tracking += 1
        return {"trackingId": self.tracking, "id": uid(f"action:{self.tracking}:{name}"), "name": name,
                "uiMetaData": {"collapsed": False}, "__type": kind}

    def add(self, a):
        self.actions.append(a)
        return a

    def update(self, name, assignments):
        a = self._base("UpdateVariableAction", name)
        a["variables"] = [{"expression": expr(e), "variable": varref(v)} for v, e in assignments]
        return self.add(a)

    def decision(self, name, condition):
        a = self._base("DecisionAction", name)
        a["expression"] = expr(condition)
        a["paths"] = [{"label": "Yes", "outputId": "__YES__", "uiMetaData": {"collapsed": False}},
                      {"label": "No", "outputId": "__NO__", "uiMetaData": {"collapsed": False}}]
        return self.add(a)

    def loop(self, name, count_var, index_var):
        a = self._base("LoopAction", name)
        a["currentIndex"] = varref(index_var)
        a["loopCount"] = expr(count_var)
        a["path"] = {"label": "Loop", "outputId": "__LOOP__", "uiMetaData": {"collapsed": False}}
        return self.add(a)

    def wait(self, name, seconds):
        a = self._base("WaitAction", name)
        a["trimDurationNearMaxRunningTime"] = lit(False, "bln")
        dur = f"P0D0H{seconds // 60}M{seconds % 60}S0F"
        a["duration"] = {"config": {"lit": {"pos": 1, "text": dur, "type": "dur"}}, "text": dur, "type": "dur",
                         "uiMetaData": {"mode": 1}, "metaData": {}, "version": 2}
        return self.add(a)

    def exit_loop(self, name="Exit Loop"):
        return self.add(self._base("ExitLoopAction", name))

    def end(self, name="End Workflow"):
        a = self._base("EndWorkflowAction", name)
        a["exitReason"] = empty("str")
        return self.add(a)

    def data_action(self, name, da_name, inputs, outputs=()):
        da = DATA_ACTIONS[da_name]
        a = self._base("DataAction", name)
        a.update({
            "actionName": da["name"], "actionId": da["id"], "category": {"id": CATEGORY, "name": CATEGORY},
            "useSuggestedTimeout": True,
            "errorBindings": [{"name": b["name"], "value": empty(b["type"])} for b in ERROR_BINDINGS],
            "processingPrompt": {**empty("pmt"), "outOfService": True},
            "inputs": [{"name": k, "value": expr(v)} for k, v in inputs],
            "outputs": [{"name": k, "value": varref(v)} for k, v in outputs],
            "timeout": {"config": {"lit": {"pos": 1, "text": "P0D0H1M0S0F", "type": "dur"}}, "text": "P0D0H1M0S0F", "type": "dur",
                        "uiMetaData": {"mode": 1}, "metaData": {}, "version": 2},
            "paths": [{"label": "Success", "outputId": "__SUCCESS__", "uiMetaData": {"collapsed": False}},
                      {"label": "Failure", "outputId": "__FAILURE__", "uiMetaData": {"collapsed": False}},
                      {"label": "Timeout", "outputId": "__TIMEOUT__", "uiMetaData": {"collapsed": False}}],
        })
        return self.add(a)


def chain(*actions):
    """Links actions sequentially via nextAction; returns the first."""
    for a, b in zip(actions, actions[1:]):
        a["nextAction"] = b["id"]
    return actions[0]


def path(action, label, first):
    """Attaches the chain starting at `first` to the branch `label` of `action`."""
    key = "path" if "path" in action else "paths"
    targets = [action[key]] if key == "path" else action[key]
    for p in targets:
        if p["label"] == label:
            p["nextActionId"] = first["id"]
            return
    raise KeyError(label)


def status_inputs():
    return [
        ("CONVERSATION_ID", "Flow.conversationId"),
        ("PARTICIPANT_ID", "Flow.customerParticipantId"),
        ("STATUS", "Flow.alertText"),
        ("LEVEL", "ToString(Flow.level)"),
        ("CRITICAL", 'If(Flow.level == 2, "true", "false")'),
        ("WARNING", 'If(Flow.level == 1, "true", "false")'),
        ("SINCE", 'If(Flow.level > 0, Flow.waitingSince, "")'),
        ("UPDATED", "ToString(GetCurrentDateTimeUtc())"),
    ]


def build():
    f = Flow()
    # --- main chain
    init = f.update("Initialise", [("Flow.graceLeft", "Flow.alertingGracePolls")])
    loop = f.loop("Poll until the interaction leaves the agent", "Flow.maxPolls", "Flow.pollIndex")
    end = f.end()
    chain(init, loop, end)

    # --- loop body
    wait = f.wait("Wait between polls", 20)
    get_state = f.data_action("Get Message Reply State", "Get Message Reply State",
                              [("CONVERSATION_ID", "Flow.conversationId")],
                              [(k, "Flow." + k) for k in ("awaitingReply", "anyAgentConnected", "customerConnected", "waitingSince",
                                                          "lastInboundTime", "lastOutboundTime", "agentConnectedTime", "agentStates",
                                                          "agentNames", "customerName", "customerParticipantId", "channel")])
    path(loop, "Loop", chain(wait, get_state))

    # failure / timeout: count, give up after N consecutive failures
    for label in ("Failure", "Timeout"):
        count = f.update(f"Count {label.lower()}", [("Flow.failures", "Flow.failures + 1")])
        too_many = f.decision("Too many consecutive failures?", "Flow.failures >= Flow.maxConsecutiveFailures")
        path(too_many, "Yes", f.exit_loop("Give up (API unavailable)"))
        path(get_state, label, chain(count, too_many))

    # success
    evaluate = f.update("Evaluate my participant", [
        ("Flow.myConnected", 'Find(Flow.agentStates, Append(Flow.userId, ":connected")) >= 0'),
        ("Flow.myAlerting", 'Find(Flow.agentStates, Append(Flow.userId, ":alerting")) >= 0'),
        ("Flow.failures", "0"),
    ])
    mine = f.decision("Still my interaction?", "Flow.myConnected")
    path(get_state, "Success", chain(evaluate, mine))

    ringing = f.decision("Still ringing (not accepted yet)?", "Flow.myAlerting and Flow.graceLeft > 0")
    path(ringing, "Yes", f.update("Use one grace poll", [("Flow.graceLeft", "Flow.graceLeft - 1")]))
    path(ringing, "No", f.exit_loop("Interaction left this agent"))
    path(mine, "No", ringing)

    waiting = f.decision("Customer waiting on me?", "Flow.awaitingReply")
    path(mine, "Yes", waiting)

    # not waiting: clear a visible alert, reset counters
    was_alerting = f.decision("Was an alert showing?", "Flow.level > 0")
    cleared = f.update("Compose cleared status", [("Flow.alertText", '"✅ Replied - no customer message waiting"'), ("Flow.level", "0")])
    write_cleared = f.data_action("Set Watchdog Status (cleared)", "Set Watchdog Status", status_inputs())
    path(was_alerting, "Yes", chain(cleared, write_cleared))
    reset = f.update("Reset alert state", [("Flow.level", "0"), ("Flow.alertedFor", '""'), ("Flow.waitedSeconds", "0"), ("Flow.pollsSinceAlert", "0")])
    chain(was_alerting, reset)
    path(waiting, "No", was_alerting)

    # waiting: track, escalate
    track = f.update("Track the wait", [
        ("Flow.waitedSeconds", "If(Flow.trackedSince == Flow.waitingSince, Flow.waitedSeconds + Flow.pollSeconds, Flow.pollSeconds)"),
        ("Flow.trackedSince", "Flow.waitingSince"),
        ("Flow.level", 'If(Flow.alertedFor != "" and Flow.alertedFor != Flow.waitingSince, 0, Flow.level)'),
        ("Flow.pollsSinceAlert", "Flow.pollsSinceAlert + 1"),
    ])
    critical_due = f.decision("Critical threshold reached?", "Flow.waitedSeconds >= Flow.criticalAfterSeconds")
    path(waiting, "Yes", chain(track, critical_due))

    send_critical = f.decision("Send critical alert now?",
                               "Flow.level < 2 or (Flow.repeatEverySeconds > 0 and Flow.pollsSinceAlert * Flow.pollSeconds >= Flow.repeatEverySeconds)")
    compose_c = f.update("Compose critical alert", [
        ("Flow.alertText", 'Append("🔴 REPLY NEEDED: ", Flow.customerName, " (", Flow.channel, ") has been waiting for your reply for more than ", ToString(Flow.criticalAfterSeconds), " seconds. Please open the interaction and respond.")'),
        ("Flow.level", "2"), ("Flow.alertedFor", "Flow.waitingSince"), ("Flow.pollsSinceAlert", "0"),
    ])
    write_c = f.data_action("Set Watchdog Status (critical)", "Set Watchdog Status", status_inputs())
    chat_c = f.data_action("Send Agent Chat Message (critical)", "Send Agent Chat Message", [("USER_ID", "Flow.userId"), ("MESSAGE", "Flow.alertText")])
    path(send_critical, "Yes", chain(compose_c, write_c, chat_c))
    path(critical_due, "Yes", send_critical)

    warn_due = f.decision("Warning threshold reached?", "Flow.level < 1 and Flow.waitedSeconds >= Flow.warnAfterSeconds")
    compose_w = f.update("Compose warning alert", [
        ("Flow.alertText", 'Append("🟠 ", Flow.customerName, " (", Flow.channel, ") is waiting for your reply - more than ", ToString(Flow.warnAfterSeconds), " seconds without a response.")'),
        ("Flow.level", "1"), ("Flow.alertedFor", "Flow.waitingSince"), ("Flow.pollsSinceAlert", "0"),
    ])
    write_w = f.data_action("Set Watchdog Status (warning)", "Set Watchdog Status", status_inputs())
    chat_w = f.data_action("Send Agent Chat Message (warning)", "Send Agent Chat Message", [("USER_ID", "Flow.userId"), ("MESSAGE", "Flow.alertText")])
    path(warn_due, "Yes", chain(compose_w, write_w, chat_w))
    path(critical_due, "No", warn_due)

    state_id = uid("state:main")
    state = {"startAction": init["id"], "trackingId": 10, "id": state_id, "name": "Main", "uiMetaData": {"collapsed": False},
             "__type": "State", "actionList": f.actions, "variables": []}

    manifest_actions = []
    for da in DATA_ACTIONS.values():
        ctx = [{"actionName": "Call Data Action", "id": a["id"], "name": "Call Data Action"} for a in f.actions if a["__type"] == "DataAction" and a["actionId"] == da["id"]]
        manifest_actions.append({"name": da["name"], "id": da["id"], "context": ctx})

    return {
        "nextTrackingNumber": f.tracking + 1,
        "defaultLanguage": "en-US",
        "description": "Started by a trigger when a message interaction reaches an agent. Polls the conversation and alerts the agent (Collaborate chat + script banner) when the customer has waited too long for a reply. See docs/build-guide.md.",
        "initialSequence": state_id,
        "name": "Unanswered Message Watchdog",
        "uiMetaData": {"bridgeServerActions": [], "screenPops": [], "actionServiceActions": [service_action_entry(da) for da in DATA_ACTIONS.values()]},
        "supportedLanguages": ["en-US"],
        "manifest": {"dataAction": manifest_actions, "language": [{"id": "en-US"}], "userPrompt": [], "systemPrompt": []},
        "type": "workflow",
        "debugSettings": {},
        "errorHandling": {"queue": {**empty("que"), "outOfService": True}, "handlingType": "EndWorkflow"},
        "customDefinitions": {"dataTypeDefinitions": []},
        "defaultSettings": {},
        "flowMetaData": {"flowDocumentVersion": "1.0", "minimumServerVersion": "1.0", "ttsDataVersion": "1.0"},
        "flowSequenceItemList": [state],
        "supportedLanguageOptions": [{"language": "en-US"}],
        "variables": [variable_def(n, k, i, inp) for n, k, i, inp, _ in VARIABLES],
    }


def encode(doc):
    text = json.dumps(doc, separators=(",", ":"), ensure_ascii=False)
    return base64.b64encode(urllib.parse.quote(text, safe="-_.!~*'()").encode("ascii")).decode("ascii")


def decode(blob):
    return json.loads(urllib.parse.unquote(base64.b64decode(blob).decode("ascii")))


if __name__ == "__main__":
    doc = build()
    out = HERE / "Unanswered-Message-Watchdog.i3WorkFlow"
    out.write_text(encode(doc), encoding="ascii")
    print("wrote", out, f"({out.stat().st_size} bytes, {len(doc['flowSequenceItemList'][0]['actionList'])} actions)")
    if "--json" in sys.argv:
        (HERE / "Unanswered-Message-Watchdog.i3WorkFlow.json").write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n")
        print("wrote readable copy")
