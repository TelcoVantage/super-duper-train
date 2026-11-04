#!/usr/bin/env python3
"""
Unit tests for the Velocity success template of the "Get Message Reply State"
data action. Genesys Cloud renders the template with Apache Velocity (Java); here
we render the exact same template text with the `airspeed` Python engine and
emulate the two Java-isms it uses (String.compareTo and $esc.jsonString).

    pip install airspeed
    python3 test/test_reply_state_template.py
"""
import json
import pathlib
import sys
import unittest

try:
    import airspeed
except ImportError:  # pragma: no cover
    sys.exit("pip install airspeed  (Velocity engine used to run the template tests)")

ROOT = pathlib.Path(__file__).resolve().parents[1]
TEMPLATE = (ROOT / "data-actions" / "templates" / "get-message-reply-state.success.vm").read_text()
BUILT = json.loads((ROOT / "data-actions" / "Get-Message-Reply-State.json").read_text())


class JStr(str):
    """Python str with Java's compareTo, as used by the template."""

    def compareTo(self, other):
        return (self > other) - (self < other)


class Esc:
    def jsonString(self, value):
        return json.dumps(str(value))[1:-1]


def javaify(value):
    if isinstance(value, dict):
        return {k: javaify(v) for k, v in value.items()}
    if isinstance(value, list):
        return [javaify(v) for v in value]
    if isinstance(value, str):
        return JStr(value)
    return value


def render(conversation):
    out = airspeed.Template(TEMPLATE).merge({"participants": javaify(conversation["participants"]), "esc": Esc()})
    out = out.replace("True", "true").replace("False", "false")  # Python vs Java boolean spelling
    return json.loads(out)


T = "2026-01-01T10:%02d:%02d.000Z"


def t(minute, second=0):
    return T % (minute, second)


def msg(mid, time, status, mtype="Text"):
    return {"messageId": mid, "messageTime": time, "messageStatus": status, "messageMetadata": {"type": mtype}}


def conversation(agent_state="connected", agent_connected=t(1), customer_msgs=(), agent_msgs=(), agent_user="agent-1",
                 extra_participants=(), customer_state="connected"):
    return {
        "id": "conv-1",
        "participants": [
            {"id": "p-cust", "purpose": "customer", "name": "Jane Doe", "state": customer_state, "type": "webmessaging",
             "messages": list(customer_msgs)},
            {"id": "p-acd", "purpose": "acd", "state": "disconnected", "messages": list(customer_msgs)},
            {"id": "p-agent", "purpose": "agent", "name": "Sam Agent", "state": agent_state, "connectedTime": agent_connected,
             "type": "webmessaging", "user": {"id": agent_user}, "messages": list(customer_msgs) + list(agent_msgs)},
            *extra_participants,
        ],
    }


class ReplyStateTemplateTests(unittest.TestCase):
    def test_built_json_embeds_current_template(self):
        self.assertEqual(BUILT["config"]["response"]["successTemplate"], TEMPLATE)
        self.assertEqual(BUILT["config"]["request"]["requestUrlTemplate"], "/api/v2/conversations/messages/${input.CONVERSATION_ID}")

    def test_customer_waiting_after_agent_connected(self):
        out = render(conversation(customer_msgs=[msg("m1", t(0, 30), "received"), msg("m2", t(2), "received")]))
        self.assertTrue(out["awaitingReply"])
        self.assertEqual(out["waitingSince"], t(2))
        self.assertEqual(out["lastInboundTime"], t(2))
        self.assertEqual(out["lastOutboundTime"], "")
        self.assertEqual(out["agentStates"], "agent-1:connected")
        self.assertEqual(out["agentNames"], "Sam Agent")
        self.assertEqual(out["customerName"], "Jane Doe")
        self.assertEqual(out["channel"], "webmessaging")
        self.assertEqual(out["customerParticipantId"], "p-cust")
        self.assertEqual(out["inboundMessageCount"], 6)  # m1,m2 are listed under customer, acd and agent participants

    def test_queue_wait_before_connect_starts_clock_at_connect(self):
        out = render(conversation(agent_connected=t(5), customer_msgs=[msg("m1", t(0), "received")]))
        self.assertTrue(out["awaitingReply"])
        self.assertEqual(out["waitingSince"], t(5))

    def test_agent_reply_clears_and_new_customer_message_restarts(self):
        replied = conversation(customer_msgs=[msg("m1", t(2), "received")], agent_msgs=[msg("m2", t(3), "sent")])
        self.assertFalse(render(replied)["awaitingReply"])
        again = conversation(customer_msgs=[msg("m1", t(2), "received"), msg("m3", t(4), "received")],
                             agent_msgs=[msg("m2", t(3), "delivery-success")])
        out = render(again)
        self.assertTrue(out["awaitingReply"])
        self.assertEqual(out["waitingSince"], t(4))
        self.assertEqual(out["lastOutboundTime"], t(3))

    def test_bot_reply_before_agent_connect_does_not_count(self):
        out = render(conversation(agent_connected=t(5), customer_msgs=[msg("m1", t(0), "received")],
                                  agent_msgs=[msg("bot", t(0, 10), "sent")]))
        self.assertTrue(out["awaitingReply"], "agent still owes a greeting after the bot hand-off")
        self.assertEqual(out["waitingSince"], t(5))

    def test_receipts_events_removed_and_failed_are_ignored(self):
        out = render(conversation(
            customer_msgs=[msg("m1", t(2), "received"), msg("r1", t(9), "received", "Receipt"), msg("e1", t(9, 30), "received", "Event"),
                           msg("x1", t(9, 40), "removed")],
            agent_msgs=[msg("m2", t(3), "sent"), msg("f1", t(1), "failed")]))
        self.assertFalse(out["awaitingReply"], "a read receipt must not look like a new customer message")
        self.assertEqual(out["lastInboundTime"], t(2))
        self.assertEqual(out["lastOutboundTime"], t(3))

    def test_not_awaiting_when_agent_not_connected(self):
        for state in ("alerting", "disconnected", "terminated"):
            out = render(conversation(agent_state=state, customer_msgs=[msg("m1", t(2), "received")]))
            self.assertFalse(out["awaitingReply"], state)
            self.assertFalse(out["anyAgentConnected"])
            self.assertEqual(out["agentStates"], f"agent-1:{state}")

    def test_transfer_lists_every_agent_participant(self):
        extra = [{"id": "p-agent2", "purpose": "agent", "name": "Alex Agent", "state": "connected", "connectedTime": t(6),
                  "type": "webmessaging", "user": {"id": "agent-2"}, "messages": []}]
        out = render(conversation(agent_state="disconnected", customer_msgs=[msg("m1", t(2), "received")], extra_participants=extra))
        self.assertEqual(out["agentStates"], "agent-1:disconnected;agent-2:connected")
        self.assertEqual(out["agentNames"], "Alex Agent")
        self.assertTrue(out["awaitingReply"])
        self.assertEqual(out["waitingSince"], t(6), "clock restarts when the new agent connects")

    def test_customer_name_is_json_escaped_and_empty_conversation_is_safe(self):
        conv = conversation(customer_msgs=[msg("m1", t(2), "received")])
        conv["participants"][0]["name"] = 'Jo "JJ" O\'Neil \\ <b>'
        out = render(conv)
        self.assertEqual(out["customerName"], 'Jo "JJ" O\'Neil \\ <b>')
        out = render({"participants": []})
        self.assertFalse(out["awaitingReply"])
        self.assertEqual(out["waitingSince"], "")
        self.assertEqual(out["inboundMessageCount"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=1)
