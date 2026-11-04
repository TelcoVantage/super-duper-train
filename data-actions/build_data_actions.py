#!/usr/bin/env python3
"""
Assembles the importable Genesys Cloud data-action JSON files in this folder
from the readable Velocity templates in ./templates.

    python3 data-actions/build_data_actions.py

Import the generated *.json files in Genesys Cloud:
Admin > Integrations > Actions > Import  (integration: "Genesys Cloud Data Actions")
"""
import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
TPL = HERE / "templates"
SCHEMA = "http://json-schema.org/draft-04/schema#"


def schema(title, properties, required=()):
    return {
        "$schema": SCHEMA,
        "title": title,
        "type": "object",
        "properties": properties,
        "required": list(required),
        "additionalProperties": True,
    }


def action(name, request, response, inputs, outputs, required_inputs=()):
    return {
        "name": name,
        "integrationType": "purecloud-data-actions",
        "actionType": "custom",
        "config": {"request": request, "response": response},
        "contract": {
            "input": {"inputSchema": schema("Input", inputs, required_inputs)},
            "output": {"successSchema": schema("Output", outputs)},
        },
        "secure": False,
    }


S = {"type": "string"}
B = {"type": "boolean"}
I = {"type": "integer"}

ACTIONS = {
    "Get-Message-Reply-State.json": action(
        name="Get Message Reply State",
        request={
            "requestUrlTemplate": "/api/v2/conversations/messages/${input.CONVERSATION_ID}",
            "requestType": "GET",
            "headers": {},
            "requestTemplate": "${input.rawRequest}",
        },
        response={
            "translationMap": {"participants": "$.participants"},
            "translationMapDefaults": {"participants": "[]"},
            "successTemplate": (TPL / "get-message-reply-state.success.vm").read_text(),
        },
        inputs={"CONVERSATION_ID": {**S, "description": "Conversation id of the message interaction"}},
        required_inputs=["CONVERSATION_ID"],
        outputs={
            "anyAgentConnected": {**B, "description": "True while any agent participant is connected"},
            "customerConnected": B,
            "awaitingReply": {**B, "description": "True when the customer is waiting on an agent reply"},
            "waitingSince": {**S, "description": "ISO-8601 UTC; later of last customer message and agent connect time ('' if none)"},
            "lastInboundTime": S,
            "lastOutboundTime": S,
            "agentConnectedTime": S,
            "agentStates": {**S, "description": "'userId:state;userId:state' for every agent participant"},
            "agentNames": {**S, "description": "Display names of the connected agent(s), '; ' separated"},
            "customerName": S,
            "customerParticipantId": S,
            "channel": {**S, "description": "webmessaging, sms, whatsapp, facebook, instagram, line, open, apple ..."},
            "inboundMessageCount": {**I, "description": "Customer message entries seen across participants (informational, may double count)"},
        },
    ),
    "Send-Agent-Chat-Message.json": action(
        name="Send Agent Chat Message",
        request={
            "requestUrlTemplate": "/api/v2/chats/users/${input.USER_ID}/messages",
            "requestType": "POST",
            "headers": {},
            "requestTemplate": '{"message": "$esc.jsonString(${input.MESSAGE})"}',
        },
        response={
            "translationMap": {"id": "$.id"},
            "translationMapDefaults": {"id": '""'},
            "successTemplate": '{"messageId": "${id}"}',
        },
        inputs={
            "USER_ID": {**S, "description": "Genesys Cloud user id of the agent to notify"},
            "MESSAGE": {**S, "description": "Plain-text chat message"},
        },
        required_inputs=["USER_ID", "MESSAGE"],
        outputs={"messageId": S},
    ),
    "Set-Watchdog-Status.json": action(
        name="Set Watchdog Status",
        request={
            "requestUrlTemplate": "/api/v2/conversations/messages/${input.CONVERSATION_ID}/participants/${input.PARTICIPANT_ID}/attributes",
            "requestType": "PATCH",
            "headers": {},
            # Keys are read by the agent script as input variables of the same name.
            "requestTemplate": (
                '{"attributes": {'
                '"rw_status": "$esc.jsonString(${input.STATUS})", '
                '"rw_level": "${input.LEVEL}", '
                '"rw_critical": "${input.CRITICAL}", '
                '"rw_warning": "${input.WARNING}", '
                '"rw_since": "${input.SINCE}", '
                '"rw_updated": "${input.UPDATED}"'
                '}}'
            ),
        },
        response={
            "translationMap": {},
            "translationMapDefaults": {},
            "successTemplate": '{"ok": true}',
        },
        inputs={
            "CONVERSATION_ID": S,
            "PARTICIPANT_ID": {**S, "description": "Customer participant id (survives transfers; scripts read attributes from any participant)"},
            "STATUS": {**S, "description": "Banner text shown in the agent script"},
            "LEVEL": {**S, "description": "0 = ok, 1 = warning, 2 = critical"},
            "CRITICAL": {**S, "description": "true / false, drives the red banner's Visible property"},
            "WARNING": {**S, "description": "true / false, drives the amber banner's Visible property"},
            "SINCE": {**S, "description": "ISO-8601 time the customer has been waiting since ('' when not waiting)"},
            "UPDATED": {**S, "description": "ISO-8601 time of this update"},
        },
        required_inputs=["CONVERSATION_ID", "PARTICIPANT_ID", "STATUS", "LEVEL", "CRITICAL", "WARNING"],
        outputs={"ok": B},
    ),
    "Set-Participant-Attribute.json": action(
        name="Set Participant Attribute",
        request={
            "requestUrlTemplate": "/api/v2/conversations/messages/${input.CONVERSATION_ID}/participants/${input.PARTICIPANT_ID}/attributes",
            "requestType": "PATCH",
            "headers": {},
            "requestTemplate": '{"attributes": {"$esc.jsonString(${input.KEY})": "$esc.jsonString(${input.VALUE})"}}',
        },
        response={
            "translationMap": {},
            "translationMapDefaults": {},
            "successTemplate": '{"ok": true}',
        },
        inputs={
            "CONVERSATION_ID": S,
            "PARTICIPANT_ID": {**S, "description": "Participant to write the attribute on (use the customer participant: it survives transfers)"},
            "KEY": S,
            "VALUE": S,
        },
        required_inputs=["CONVERSATION_ID", "PARTICIPANT_ID", "KEY", "VALUE"],
        outputs={"ok": B},
    ),
}

if __name__ == "__main__":
    for filename, body in ACTIONS.items():
        (HERE / filename).write_text(json.dumps(body, indent=2) + "\n")
        print("wrote", filename)
