# Trigger: message connected to agent

`message-connected-to-agent.trigger.json` is the request body for
`POST /api/v2/processautomation/triggers` (Developer Tools → API Explorer, or the
Genesys Cloud CLI: `gc processautomation triggers create -f message-connected-to-agent.trigger.json`).
You can also create it by hand in **Admin → Orchestration → Triggers**; the
build guide lists the exact values.

| Field | Value | Why |
|---|---|---|
| Topic | `v2.detail.events.conversation.{id}.user.start` | Fires when a user (agent) participant starts on a conversation, i.e. the interaction is offered/connected to an agent. |
| Workflow target | *Unanswered Message Watchdog* (must be published) | The watchdog logic. |
| Data format | `TopLevelPrimitives` | The event's top-level fields (`conversationId`, `userId`, `participantId`, `mediaType`, `queueId` …) are passed straight into the workflow's input variables of the same name. Names are case-sensitive. |
| Condition | `mediaType` **Equal** `message` | Only digital message interactions. Pick the value from the Event Schema panel so the spelling/case matches your org's schema. Add a second condition on `queueId` (operator *In*, list of queue ids) to pilot on a few queues first. |
| TTL | 120 s | If event delivery is delayed by more than two minutes, skip it (the agent has probably replied already). |
| Delayed start | leave default | A 60–900 s delayed start is possible, but the workflow starts its own clock from the agent-connect time, so no delay is needed. |
| Enabled | false until the workflow is published and tested | Flip to Active in the UI when ready. |

Replace `REPLACE_WITH_WORKFLOW_FLOW_ID` with the workflow's flow id (Architect →
the workflow → the id in the browser URL, or `GET /api/v2/flows?type=workflow&name=Unanswered Message Watchdog`).
