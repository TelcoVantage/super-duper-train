#!/usr/bin/env python3
"""
Generates scripts/Reply-Watch.script – a Genesys Cloud agent script you import
through the GUI (Admin > Digital and Telephony > Interaction Assets > Scripts >
Import). The JSON shape follows real script exports (page/rootContainer/
component property maps, variables referenced by id inside {{...}}, custom
actions with "if" blocks, page onLoadAction).

    python3 scripts/build_reply_watch_script.py

What the script shows (see docs/agent-workspace-script.md):
  * red banner   – visible while participant attribute rw_critical == "true"
  * amber banner – visible while rw_warning  == "true"
  * status line, "waiting since / updated" line
  * "Check now" button -> custom action: Refresh Input Variables,
    then Alert when rw_level == "2". The same action runs on page load.
"""
import json
import pathlib
import uuid

HERE = pathlib.Path(__file__).resolve().parent
NS = uuid.UUID("5f1c3c6e-9b4a-4e0e-8d4c-0b6c7f6a1d21")  # stable ids -> re-import replaces cleanly


def uid(name):
    return str(uuid.uuid5(NS, name))


SCRIPT_ID = uid("script")
VERSION_ID = uid("version")
PAGE_ID = uid("page:reply-watch")
ACTION_CHECK = uid("action:check-reply-status")

VARS = [
    # name, type, default, description
    ("rw_status", "string", "No customer message is waiting.", "Banner text written by the Unanswered Message Watchdog workflow"),
    ("rw_level", "string", "0", "0 = ok, 1 = warning, 2 = critical"),
    ("rw_critical", "boolean", False, "true while the critical banner should show"),
    ("rw_warning", "boolean", False, "true while the warning banner should show"),
    ("rw_since", "string", "", "ISO-8601 UTC time the customer has been waiting since"),
    ("rw_updated", "string", "", "ISO-8601 UTC time the status was last written"),
]
VID = {name: uid(f"var:{name}") for name, *_ in VARS}


def ref(name):
    return "{{" + VID[name] + "}}"


FONT = 'Arial, "Helvetica Neue", Helvetica, sans-serif'


def sizing(kind, size=100):
    return {"typeName": "sizing", "value": {"sizeType": kind, "size": size}} if kind != "auto" else {"typeName": "sizing", "value": {"sizeType": "auto"}}


def color(hex_or_none):
    return {"typeName": "color", "value": hex_or_none} if hex_or_none else {"typeName": "null"}


def visible(var_name=None):
    return {"typeName": "variable", "value": VID[var_name]} if var_name else {"typeName": "variable"}


def text(value, *, size=12, bold=False, bg=None, fg=None, padding=0, margin=(0, 0, 6, 0), visible_var=None):
    return {
        "type": "text",
        "properties": {
            "margin": {"typeName": "spacing", "value": list(margin)},
            "alignment": {"typeName": "alignment", "value": "start"},
            "width": sizing("stretch"),
            "height": sizing("auto"),
            "visible": visible(visible_var),
            "preserveLayoutLocation": {"typeName": "boolean", "value": False},
            "text": {"typeName": "interpolatedText", "value": value},
            "bold": {"typeName": "boolean", "value": bold},
            "italic": {"typeName": "boolean", "value": False},
            "underline": {"typeName": "boolean", "value": False},
            "font": {"typeName": "font", "value": FONT},
            "fontSize": {"typeName": "integer", "value": size},
            "justification": {"typeName": "text", "value": "left"},
            "backgroundColor": color(bg),
            "textColor": color(fg),
            "padding": {"typeName": "spacing", "value": padding},
        },
    }


def button(label, action_id, *, bg="#2a60c8", fg="#ffffff"):
    return {
        "type": "button",
        "properties": {
            "margin": {"typeName": "spacing", "value": [0, 0, 6, 0]},
            "alignment": {"typeName": "alignment", "value": "start"},
            "width": sizing("auto"),
            "height": sizing("auto"),
            "visible": visible(),
            "text": {"typeName": "interpolatedText", "value": label},
            "clickAction": {"typeName": "action", "value": {"actionName": action_id, "actionArgumentValues": []}},
            "backgroundColor": color(bg),
            "textColor": color(fg),
            "disabled": {"typeName": "variable"},
        },
    }


def step(action_name, *args):
    return {"type": "action", "actionName": action_name, "actionArgumentValues": list(args)}


def interpolated(value):
    return {"typeName": "interpolatedText", "value": value}


page = {
    "id": PAGE_ID,
    "name": "Reply Watch",
    "properties": {
        "onLoadAction": {"typeName": "action", "value": {"actionName": ACTION_CHECK, "actionArgumentValues": []}},
        "backgroundColor": {"typeName": "null"},
    },
    "dataVersion": 0,
    "rootContainer": {
        "type": "verticalStackContainer",
        "properties": {
            "margin": {"typeName": "spacing", "value": 0},
            "alignment": {"typeName": "alignment", "value": "start"},
            "width": sizing("stretch"),
            "height": sizing("stretch"),
            "visible": visible(),
            "preserveLayoutLocation": {"typeName": "boolean", "value": False},
            "backgroundColor": {"typeName": "null"},
            "padding": {"typeName": "spacing", "value": 10},
            "childArrangement": {"typeName": "childArrangement", "value": "start"},
            "border": {"typeName": "border", "value": {"width": 0, "style": "solid", "color": "000000"}},
        },
        "children": [
            text("🔴 " + ref("rw_status"), size=14, bold=True, bg="#d93025", fg="#ffffff", padding=12, visible_var="rw_critical"),
            text("🟠 " + ref("rw_status"), size=13, bold=True, bg="#f9a825", fg="#1d2430", padding=12, visible_var="rw_warning"),
            text("REPLY WATCH", size=11, bold=True, fg="#2a60c8", margin=(0, 0, 2, 0)),
            text("Status: " + ref("rw_status"), size=12, fg="#334155"),
            text("Waiting since " + ref("rw_since") + "  ·  updated " + ref("rw_updated") + " (UTC)", size=10, fg="#64748b"),
            button("Check now", ACTION_CHECK),
            text("The status refreshes when this page loads and when you press Check now. The chat pop-up tells you when to look.", size=10, fg="#64748b"),
        ],
    },
}

check_action = {
    "id": ACTION_CHECK,
    "name": "Check reply status",
    "action": {
        "block": [
            step("scripter.refreshInputVariables"),
            {
                "type": "if",
                "condition": {
                    "type": "standard",
                    "leftHandSide": {"typeName": "variable", "value": VID["rw_level"]},
                    "operator": "equal",
                    "rightHandSide": interpolated("2"),
                },
                "ifBlock": [step("scripter.alert", interpolated(ref("rw_status")))],
                "elseBlock": [],
            },
        ]
    },
}

features = {
    "dialer": {"properties": {"enabled": {"typeName": "boolean", "value": False}, "contactListId": {"typeName": "text", "value": ""}, "onContactDataLoadAction": {"typeName": "action", "value": {}}}},
    "scripter": {"properties": {"enabled": {"typeName": "boolean", "value": True}}},
    "screenPop": {"properties": {"enabled": {"typeName": "boolean", "value": True}}},
    "callback": {"properties": {"enabled": {"typeName": "boolean", "value": False}}},
    "chat": {"properties": {"enabled": {"typeName": "boolean", "value": True}}},
    "email": {"properties": {"enabled": {"typeName": "boolean", "value": False}}},
    "message": {"properties": {"enabled": {"typeName": "boolean", "value": True}}},
    "bridge": {"properties": {"enabled": {"typeName": "boolean", "value": False}}},
    "uuiData": {"properties": {"enabled": {"typeName": "boolean", "value": False}}},
    "customerSecuredData": {"properties": {"enabled": {"typeName": "boolean", "value": False}}},
    "list": {"properties": {"enabled": {"typeName": "boolean", "value": False}}},
}

script = {
    "id": SCRIPT_ID,
    "name": "Reply Watch",
    "versionId": VERSION_ID,
    "startPageId": PAGE_ID,
    "pages": [page],
    "features": features,
    "variables": [
        {
            "id": VID[name],
            "name": name,
            "description": desc,
            "type": {"isDynamic": False, "isList": False, "name": vtype},
            "value": default,
            "input": True,
            "output": False,
        }
        for name, vtype, default, desc in VARS
    ],
    "customActions": [check_action],
    "dataVersion": 0,
}

if __name__ == "__main__":
    out = HERE / "Reply-Watch.script"
    out.write_text(json.dumps(script, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("wrote", out, f"({out.stat().st_size} bytes)")
