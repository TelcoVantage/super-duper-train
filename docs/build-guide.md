# Build guide – Unanswered Message Watchdog (100 % native Genesys Cloud)

Everything below is configured inside Genesys Cloud. Nothing is hosted outside it.
Budget: about one hour for a first build, 15 minutes to roll out to further queues.

Build order matters: data actions → group → workflow → trigger → test → enable.

---

## 0. Prerequisites

Your admin user needs these permissions (all in standard admin roles):

| Area | Permission |
|---|---|
| Integrations | Integration › Add/Edit/View, Action › Add/Edit/View/Execute |
| OAuth | OAuth › Client › Add/Edit/View |
| Architect | Architect › Flow › Add/Edit/View/Publish |
| Triggers | Process Automation › Trigger › Add/Edit/View/Test |
| Groups | Directory › Group › Add/Edit |

Agents need nothing new. They receive the alert as a Genesys Cloud **Collaborate chat** message, which pops a toast in the top-right of the Genesys Cloud UI, plays the chat sound and badges the chat icon – all standard behaviour.

---

## 1. Data Actions integration and its OAuth client

1. **Admin › Integrations › OAuth › Add Client**
   * App name: `Reply Watchdog Data Actions`
   * Grant type: **Client Credentials**
   * Roles: create (Admin › People & Permissions › Roles) and assign a dedicated role **Reply Watchdog** containing:
     * *Conversation › Communication › View* – read the message conversation (`GET /api/v2/conversations/messages/{id}`)
     * *Conversation › Communication › Edit* – only if you use the optional de-duplication attribute write (`PATCH …/participants/{id}/attributes`)
     * the permission that the API Explorer lists for `POST /api/v2/chats/users/{userId}/messages` (Developer Tools › API Explorer › Chats › *Send a message to a user* › **Required permissions**; it is in the *Chat* permission group)
   * Save and copy the client id and secret.
2. **Admin › Integrations › Integrations › + Integrations › Genesys Cloud Data Actions › Install**
   * Name: `Genesys Cloud Data Actions` (the name the workflow refers to; if you already have one, reuse it and adjust the *Category* in the workflow's Call Data Action steps).
   * Configuration › Credentials: paste the client id and secret.
   * Set the integration to **Active**.

---

## 2. Import the data actions

**Admin › Integrations › Actions › Import**, pick the integration above and import, one by one:

| File | Purpose |
|---|---|
| `data-actions/Get-Message-Reply-State.json` | Reads the conversation and returns *is the customer waiting on an agent, since when, which agents are connected, customer name, channel*. All the logic is in its success template (Velocity) – see `data-actions/templates/`. |
| `data-actions/Send-Agent-Chat-Message.json` | Sends a Collaborate direct chat message to one user – the pop-up the agent sees. |
| `data-actions/Set-Participant-Attribute.json` | Optional, for de-duplication (section 8). |

After each import, click the action › **Setup › Test**:

* *Get Message Reply State*: paste the id of a live or recent message conversation (Performance › Interactions › open one › the id is in the URL). You should see `awaitingReply`, `waitingSince`, `agentStates` such as `b3c1…:connected`, `customerName`, `channel`. If `agentStates` is empty on a live conversation, the OAuth role is missing *Conversation › Communication › View*.
* *Send Agent Chat Message*: use your own user id (Admin › People › you › the id is in the URL) and a short message. **You must receive a chat toast in the Genesys Cloud UI.** If the API refuses the call (403/400) because a client-credentials token cannot send user chat, keep the action (the workflow handles failure) and rely on the group-chat fallback in step 3; or point the action at `POST /api/v2/conversations/emails/agentless` to e-mail the agent instead.
* **Save & Publish** each action (an un-published action is invisible to Architect).

> The success template uses only Velocity features the Genesys *Velocity macros for data actions* article documents (`#set`, `#foreach`, `#if`, string methods, `$esc.jsonString`). `python3 test/test_reply_state_template.py` renders the same template against sample conversations if you change it.

---

## 3. Group for the fallback notification

**Admin › Directory › Groups › Add Group**: name **`Messaging Reply Alerts`**, type *Official*, visibility *Public*, members: the messaging agents and their team leads, and enable **Chat** for the group. The workflow posts here only when the direct chat message fails, mentioning the agent by name. (Team leads tend to like it: it doubles as a live "who is behind" feed.)

---

## 4. Build the workflow in Architect

**Admin › Architect › Flows: Workflow › + Add**: name **`Unanswered Message Watchdog`**, division *Home* (or the division of the queues).

`workflow/Unanswered-Message-Watchdog.archy.yaml` is the same flow as Archy YAML (draft; validate with `archy validate`). To build by hand, follow the tables below exactly – expression text is copy-paste ready.

### 4.1 Variables (flow settings › Variables)

Create these **Flow** variables. Inputs must be marked *Input: Yes* and must be spelled exactly like the trigger event fields.

| Name | Type | Initial | Input | Purpose |
|---|---|---|---|---|
| `Flow.conversationId` | String | – | **Yes** | from trigger |
| `Flow.userId` | String | – | **Yes** | the agent, from trigger |
| `Flow.participantId` | String | – | **Yes** | agent participant, from trigger |
| `Flow.mediaType` | String | – | **Yes** | from trigger |
| `Flow.queueId` | String | – | **Yes** | from trigger |
| `Flow.warnAfterSeconds` | Integer | `45` | No | first (soft) alert |
| `Flow.criticalAfterSeconds` | Integer | `90` | No | escalated alert |
| `Flow.repeatEverySeconds` | Integer | `60` | No | critical reminder interval, `0` = off |
| `Flow.pollSeconds` | Integer | `20` | No | must equal the Wait action duration |
| `Flow.maxRuntimeMinutes` | Integer | `480` | No | hard stop per interaction |
| `Flow.alertingGracePolls` | Integer | `6` | No | polls to tolerate while the interaction is still ringing |
| `Flow.maxConsecutiveFailures` | Integer | `5` | No | give up when the API keeps failing |
| `Flow.level` | Integer | `0` | No | 0 none · 1 warned · 2 critical |
| `Flow.alertedFor` | String | `""` | No | `waitingSince` value the last alert was about |
| `Flow.trackedSince` | String | `""` | No | for the wait counter |
| `Flow.waitedSeconds` | Integer | `0` | No | approximate wait, for messages |
| `Flow.failures` | Integer | `0` | No | consecutive data-action failures |
| `Flow.graceLeft` | Integer | `0` | No | ringing grace polls left |
| `Flow.lastAlertAt` | DateTime | – | No | |
| `Flow.deadline` | DateTime | – | No | |
| `Flow.myConnected` | Boolean | `false` | No | |
| `Flow.myAlerting` | Boolean | `false` | No | |
| `Flow.alertText` | String | `""` | No | |
| `Flow.awaitingReply` | Boolean | `false` | No | data action output |
| `Flow.anyAgentConnected` | Boolean | `false` | No | data action output |
| `Flow.customerConnected` | Boolean | `false` | No | data action output |
| `Flow.waitingSince` | String | `""` | No | data action output (ISO-8601 UTC) |
| `Flow.lastInboundTime` | String | `""` | No | data action output |
| `Flow.lastOutboundTime` | String | `""` | No | data action output |
| `Flow.agentConnectedTime` | String | `""` | No | data action output |
| `Flow.agentStates` | String | `""` | No | data action output, `userId:state;…` |
| `Flow.agentNames` | String | `""` | No | data action output |
| `Flow.customerName` | String | `""` | No | data action output |
| `Flow.customerParticipantId` | String | `""` | No | data action output |
| `Flow.channel` | String | `""` | No | data action output |

### 4.2 Task "Main" (starting task)

| # | Action | Configuration |
|---|---|---|
| 1 | **Update Data** "Initialise" | `Flow.deadline` = `AddMinutes(GetCurrentDateTimeUtc(), Flow.maxRuntimeMinutes)` · `Flow.lastAlertAt` = `GetCurrentDateTimeUtc()` · `Flow.graceLeft` = `Flow.alertingGracePolls` |
| 2 | **Loop** "Poll until the interaction leaves the agent" | Loop count `2000`, index variable `Task.i`. Everything from 2.1 to 2.9 goes *inside* the loop. |
| 2.1 | **Wait** | Duration **20 seconds** (literal). Keep it equal to `Flow.pollSeconds`. |
| 2.2 | **Call Data Action** "Get Message Reply State" | Category *Genesys Cloud Data Actions*, action *Get Message Reply State*, input `CONVERSATION_ID` = `Flow.conversationId`, timeout 30 s. **Success outputs**: map every output to the Flow variable of the same name (`awaitingReply → Flow.awaitingReply`, … `channel → Flow.channel`). **Failure** and **Timeout** paths: *Update Data* `Flow.failures` = `Flow.failures + 1` → *Decision* `Flow.failures >= Flow.maxConsecutiveFailures` → Yes: **Exit Loop**; No: **Next Loop**. |
| 2.3 | **Update Data** "Evaluate my participant" | `Flow.myConnected` = `Find(Flow.agentStates, Append(Flow.userId, ":connected")) >= 0` · `Flow.myAlerting` = `Find(Flow.agentStates, Append(Flow.userId, ":alerting")) >= 0` · `Flow.failures` = `0` |
| 2.4 | **Decision** "Still my interaction?" | `Flow.myConnected` → **No**: *Decision* `Flow.myAlerting and Flow.graceLeft > 0` → Yes: *Update Data* `Flow.graceLeft` = `Flow.graceLeft - 1`, **Next Loop**; No: **Exit Loop** (transferred, disconnected, or never accepted). **Yes**: continue. |
| 2.5 | **Decision** "Past maximum runtime?" | `GetCurrentDateTimeUtc() >= Flow.deadline` → Yes: **Exit Loop**. |
| 2.6 | **Decision** "Customer waiting on me?" | `Flow.awaitingReply` → **No**: *Update Data* `Flow.level` = `0`, `Flow.alertedFor` = `""`, `Flow.waitedSeconds` = `0`, then **Next Loop**. **Yes**: continue. |
| 2.7 | **Update Data** "Track the wait" (statements in this order) | `Flow.waitedSeconds` = `If(Flow.trackedSince == Flow.waitingSince, Flow.waitedSeconds + Flow.pollSeconds, 0)` · `Flow.trackedSince` = `Flow.waitingSince` · `Flow.level` = `If(Flow.alertedFor != "" and Flow.alertedFor != Flow.waitingSince, 0, Flow.level)` ← a *new* customer message re-arms the alerts |
| 2.8 | **Decision** "Critical threshold reached?" | `AddSeconds(ToDateTime(Flow.waitingSince), Flow.criticalAfterSeconds) <= GetCurrentDateTimeUtc()` |
| 2.8-Yes | **Decision** "Send critical alert now?" | `Flow.level < 2 or (Flow.repeatEverySeconds > 0 and AddSeconds(Flow.lastAlertAt, Flow.repeatEverySeconds) <= GetCurrentDateTimeUtc())` → Yes: *Update Data* `Flow.alertText` = `Append("🔴 REPLY NEEDED: ", Flow.customerName, " (", Flow.channel, ") has been waiting for your reply for more than ", ToString(Flow.criticalAfterSeconds), " seconds. Please open the interaction and respond.")`, `Flow.level` = `2`, `Flow.lastAlertAt` = `GetCurrentDateTimeUtc()`, `Flow.alertedFor` = `Flow.waitingSince`; then **Call Task** *Notify Agent*. |
| 2.8-No | **Decision** "Warning threshold reached?" | `Flow.level < 1 and AddSeconds(ToDateTime(Flow.waitingSince), Flow.warnAfterSeconds) <= GetCurrentDateTimeUtc()` → Yes: *Update Data* `Flow.alertText` = `Append("🟠 ", Flow.customerName, " (", Flow.channel, ") is waiting for your reply - more than ", ToString(Flow.warnAfterSeconds), " seconds without a response.")`, `Flow.level` = `1`, `Flow.lastAlertAt` = `GetCurrentDateTimeUtc()`, `Flow.alertedFor` = `Flow.waitingSince`; then **Call Task** *Notify Agent*. |
| 3 | **End Workflow** | after the loop |

### 4.3 Task "Notify Agent"

| # | Action | Configuration |
|---|---|---|
| 1 | **Call Data Action** "Send Agent Chat Message" | inputs `USER_ID` = `Flow.userId`, `MESSAGE` = `Flow.alertText`, timeout 20 s. **Success**: *End Task*. |
| 1-Failure / 1-Timeout | **Send Notification** | Notification type **Chat**, *Send to Group* = **Messaging Reply Alerts**, *Chat Message* (expression) = `Append("@", Flow.agentNames, " - ", Flow.alertText)` |
| 2 | **End Task** | |

Optional extra fallback: add a second **Send Notification** of type **Email** to the team leads.

### 4.4 Flow error handling and publish

* Flow settings › *Error handling*: **End Workflow** (an unexpected error must not leave a stuck instance).
* **Save**, then **Publish**. Note the flow id in the browser URL – the trigger needs it.

> If your Architect version does not offer `Find(...)` for strings, replace step 2.3 with a *Loop* over `Split(Flow.agentStates, ";")` comparing each item to `Append(Flow.userId, ":connected")`.

---

## 5. Create the trigger

**Admin › Orchestration › Triggers › Event Based Triggers › Add Trigger**

| Field | Value |
|---|---|
| Name | `Message connected to agent -> Unanswered Message Watchdog` |
| Topic Name | `v2.detail.events.conversation.{id}.user.start` |
| Workflow Target | *Unanswered Message Watchdog* |
| Data Format | **TopLevelPrimitives** |
| Condition 1 | JSON Path `mediaType` · Operator **Equal** · Value `message` (choose it from the Event Schema panel so case matches) |
| Condition 2 (pilot) | JSON Path `queueId` · Operator **In** · the queue ids you are piloting |
| TTL | `120` seconds |
| Delayed start | leave default |

Click **Save & Test**: paste a sample `user.start` event (Developer Tools › Notifications gives you one) and confirm the condition evaluates and the target resolves. Leave the trigger **inactive** until step 7.

The same definition is in `triggers/message-connected-to-agent.trigger.json` for the API/CLI.

---

## 6. Native queue backstop (recommended, zero build)

**Admin › Contact Center › Queues › queue › Message** › **Inactivity handling**: enable it for your messaging channels with a *Time* of e.g. 15–30 minutes and action *Disconnect* (or *Route to Architect flow*). This is a different, native timer: when **neither side** writes for that long, the conversation card shows a clock icon, turns red and Genesys Cloud notifies the agent one minute before the interaction ends. It does not replace the watchdog (it cannot tell who wrote last) but it guarantees that forgotten conversations do not sit in rosters for hours.

---

## 7. Test and enable

1. Activate the trigger.
2. Log in as an agent on a pilot messaging queue and send a test web message / SMS.
3. Accept it and **do not reply**. After ~45 s (plus up to one poll interval) a Collaborate chat toast arrives: *🟠 Jane Doe (webmessaging) is waiting for your reply…*. After ~90 s the 🔴 message arrives and repeats every 60 s.
4. Reply: no further alerts. Send another customer message and stay silent: alerts start again from zero.
5. Transfer the interaction to another agent: the first agent gets no more alerts, the second agent's own workflow instance takes over.
6. Watch the instances in **Admin › Architect › the workflow › Executions** (or `GET /api/v2/flows/executions`). Each message interaction has exactly one running instance per agent participant, and it ends when the interaction leaves the agent.

---

## 8. Optional: de-duplicate instances after transfer-back

If the same agent receives the same conversation twice (consult then transfer back), two instances may run for the same agent. To make the newest instance win: right after step 1 of *Main*, call **Set Participant Attribute** with `CONVERSATION_ID` = `Flow.conversationId`, `PARTICIPANT_ID` = `Flow.customerParticipantId` (take it from a first *Get Message Reply State* call), `KEY` = `watchdogOwner`, `VALUE` = `Flow.participantId`. Then extend the *Get Message Reply State* success template to return the customer participant's `attributes.watchdogOwner`, map it to `Flow.watchdogOwner`, and add a decision after 2.3: `Flow.watchdogOwner != "" and Flow.watchdogOwner != Flow.participantId` → **Exit Loop**.

---

## 9. Sizing, limits and cost

* **API calls**: one data action per poll per watched interaction. Load per minute ≈ *concurrent message interactions with an agent* × (60 / `pollSeconds`). With 20-second polls, 100 concurrent conversations cost 300 data-action calls per minute. Check the *Data Actions* and *Platform API* entries on the Genesys Cloud limits page for your org and raise `pollSeconds` (30–60 s) if you run thousands of concurrent conversations; the alert precision is ± one poll interval.
* **Workflow runtime**: Architect ends any workflow after 72 hours; the watchdog stops itself after `Flow.maxRuntimeMinutes` (8 h) anyway. Long-running async channels (WhatsApp threads lasting days) are re-armed every time the customer's next message reaches the agent, because that creates a new `user.start`.
* **Trigger invocations** count against the process-automation limits of your org. A condition on `queueId` keeps the trigger to the queues that need it.
* **Billing**: workflows and data actions are included with the Genesys Cloud licence tiers that include Architect; there is no per-execution charge, but check your contract if you are on usage-based pricing.

---

## 10. Troubleshooting

| Symptom | Check |
|---|---|
| Nothing happens when a message is accepted | Trigger inactive, workflow not *published*, or `mediaType` value spelt differently in your event schema (open the trigger, Event Schema panel). Use **Save & Test** with a real event from Developer Tools › Notifications. |
| Workflow starts and ends immediately | Input variable names do not match the event fields (case-sensitive), so `Flow.userId` is empty and `Find(...)` never finds `:connected`. Check the execution's input data in Architect › Executions. |
| Alerts for every poll, even after replying | The data action returns `awaitingReply` = true although the agent replied. Run the action's Test with the conversation id and inspect `lastOutboundTime`; if agent messages carry a status not handled by the template, add it to the non-`received` branch (anything that is not `received` counts as outbound already). |
| Alert arrives but no toast | The agent muted Collaborate chat notifications (Genesys Cloud profile › Preferences › Notifications) or the chat sender is blocked. The group fallback still posts. |
| `Send Agent Chat Message` fails with 403 | The OAuth role lacks the Chat permission, or your org does not allow client-credentials tokens to send user chat. The workflow falls back to the group chat automatically; e-mail is the other native option. |
| Executions pile up | Agents are not ending interactions (check the native inactivity timer in section 6) or `Flow.maxRuntimeMinutes` is too high. |
