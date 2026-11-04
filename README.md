# Unanswered Message Watchdog – native Genesys Cloud alerting for agents

> **Problem:** an agent handles several chats / messages at once. A customer writes, the agent is busy elsewhere, the message is never noticed and the customer is left hanging.
>
> **Solution, built entirely inside Genesys Cloud:** a **Trigger** starts an **Architect Workflow** every time a message interaction reaches an agent. The workflow polls the conversation through a **Data Action** and, when the customer has been waiting on *that agent* too long, pops a **Collaborate chat message** to the agent (toast + sound + badge in the Genesys Cloud UI), escalating and repeating until they reply. No external hosting, no custom app, no scripts to deploy.

```
 message interaction reaches agent
            │  v2.detail.events.conversation.{id}.user.start   (mediaType == message)
            ▼
  ┌──────────────────┐   TopLevelPrimitives: conversationId, userId, participantId …
  │     TRIGGER       │──────────────────────────────────────────────────────┐
  └──────────────────┘                                                      ▼
                                                           ┌──────────────────────────────┐
   every 20 s ──────────────────────────────────────────── │  WORKFLOW                    │
   ┌──────────────────────────────────────────┐           │  Unanswered Message Watchdog │
   │ DATA ACTION  Get Message Reply State     │◄──────────│  loop: wait → poll → decide  │
   │ GET /api/v2/conversations/messages/{id}  │           └──────────────┬───────────────┘
   │ Velocity: waitingSince / awaitingReply / │                          │ customer waiting > 45 s / 90 s
   │ agentStates / customerName / channel     │                          ▼
   └──────────────────────────────────────────┘           ┌──────────────────────────────┐
                                                           │ DATA ACTION  Send Agent Chat │ → 🔔 toast to the agent
                                                           │ POST /api/v2/chats/users/{id}│
                                                           │   fallback: Send Notification│ → team group chat / e-mail
                                                           └──────────────────────────────┘
```

## What the agent experiences (defaults)

| Customer waiting for this agent | What happens |
|---|---|
| < 45 s | nothing |
| ≥ 45 s | Collaborate chat pops: *🟠 Jane Doe (webmessaging) is waiting for your reply – more than 45 seconds without a response.* |
| ≥ 90 s | *🔴 REPLY NEEDED: Jane Doe (webmessaging) has been waiting for your reply for more than 90 seconds…*, repeated every 60 s |
| agent replies | alerts stop; the next customer message restarts the clock from zero |
| interaction transferred / ended | the instance for that agent ends by itself |

The waiting clock starts at the **later** of the customer's latest message and the moment the interaction connected to the agent, so queue time is never charged to the agent, and a bot or previous agent's reply before hand-off does not count as *this* agent's reply. Read receipts and events are ignored.

## Why these building blocks (and not the others)

| Native option | Verdict |
|---|---|
| **Scripts** (agent scripting) | No timers, no background execution, no view of other interactions. Cannot detect silence. |
| **Alert rules** (Analytics › Alerting) with in-app toasts | Great delivery mechanism, but the available single-conversation metrics are handle/talk/hold/wait/alert/ACW – none measures "time since the customer's last message without an agent reply". |
| **Queue inactivity handling** | Native timer when *either* side goes quiet; ends/reroutes the conversation and warns the agent one minute before. Recommended as a backstop (build guide § 6) but it cannot tell who wrote last. |
| **Trigger + Workflow + Data Actions** | Triggers fire on agent connect, workflows can wait/loop for hours and call data actions, data actions can read the conversation and send a chat to the agent. This is the only native combination that can implement the rule. ✅ |

## Repository layout

```
data-actions/
  Get-Message-Reply-State.json      importable data action (reads the conversation, computes the wait)
  Send-Agent-Chat-Message.json      importable data action (Collaborate DM to the agent)
  Set-Participant-Attribute.json    importable data action (optional de-duplication)
  templates/*.vm                    the Velocity success template, readable
  build_data_actions.py             regenerates the JSON from the templates
workflow/
  Unanswered-Message-Watchdog.archy.yaml   the workflow as Archy YAML (draft accelerator)
triggers/
  message-connected-to-agent.trigger.json  POST body for the trigger API + notes
docs/build-guide.md                 click-by-click build, test, sizing, troubleshooting
test/                               template unit tests + artifact validation
```

## Getting started

1. Read **[docs/build-guide.md](docs/build-guide.md)** and follow it top to bottom (data actions → group → workflow → trigger → test).
2. Tune in one place: the workflow's `Flow.warnAfterSeconds`, `Flow.criticalAfterSeconds`, `Flow.repeatEverySeconds`, `Flow.pollSeconds` (and the matching Wait action).
3. Pilot with a `queueId` condition on the trigger, then remove it.

## Verifying the logic without an org

```bash
pip install airspeed pyyaml      # Velocity engine (Python port) + YAML parser
sh test/run_tests.sh             # validates JSON/YAML artifacts, runs 9 template tests
```

The template tests render the exact Velocity text Genesys Cloud will run, against sample conversations covering: queue wait before connect, bot replies before hand-off, agent reply then new customer message, receipts/events/removed/failed messages, alerting / disconnected agents, transfers, JSON escaping of names.

## Known limits (read before rollout)

* **Polling, not push.** Genesys Cloud triggers have no per-message topic, so the workflow polls every 20 s. Alerts are accurate to ± one poll. One data-action call per poll per watched interaction – size it with the formula in the build guide.
* **Direct chat via client credentials.** `POST /api/v2/chats/users/{userId}/messages` is the pop-up channel. Test it once in your org (build guide § 2). If your org refuses user chat from an OAuth client-credentials token, the workflow automatically falls back to a group chat (`Messaging Reply Alerts`) that mentions the agent; e-mail is the other native fallback.
* **Instances per agent participant.** A transfer creates a fresh instance for the new agent and ends the old one. A consult-and-transfer-back can briefly run two instances for the same agent; § 8 of the build guide shows the optional de-duplication.
* **Legacy ACD web chat** does not expose message timestamps on the conversation and is end-of-life; the solution targets message interactions (Web Messaging, SMS, WhatsApp, Facebook, Instagram, LINE, X, Apple Messages, Open Messaging).

## History

The first iteration of this repository was a hosted Client Application (sidebar app) using the Client App SDK and the Notifications WebSocket. It was replaced by this all-native design at the customer's request; it is still available in git history (commit `ef93d6b`) if a richer in-app panel is ever wanted.
