/**
 * ConversationTracker
 * -------------------
 * Pure, framework-free state that answers one question for every conversation
 * the agent is connected to:
 *
 *   "Is the customer currently waiting on the agent, and since when?"
 *
 * It is fed Genesys Cloud conversation objects. Both of these produce the same
 * shape, so the tracker is agnostic about where they come from:
 *
 *   - REST:          GET /api/v2/conversations            (initial / periodic sync)
 *   - Notifications: v2.users.{userId}.conversations      (real-time, WebSocket)
 *
 * The rule (see `computeWaiting`):
 *
 *   waitingSince = max(latest inbound customer message, moment the agent connected)
 *   answered     = an outbound (agent) message exists at or after waitingSince
 *   awaiting     = agent communication is connected AND NOT answered
 *
 * This deliberately ignores bot/other-agent replies that happened *before* this
 * agent connected (the agent still owes a greeting) and ignores queue wait time
 * before the interaction reached the agent (not the agent's fault).
 *
 * Direction of a message is first guessed from `messageStatus` ("received" means
 * it came from the customer) and then, when available, confirmed from the
 * authoritative bulk message lookup (`applyMessageDetails`).
 */

export const CONNECTED_STATES = new Set(['connected']);
export const ALERTING_STATES = new Set(['alerting', 'contacting', 'offering']);
export const ENDED_STATES = new Set(['disconnected', 'terminated', 'none']);

/** messageStatus values that indicate a message written by the customer. */
const INBOUND_STATUSES = new Set(['received']);
/** Normalised message types that are not "real" messages and must never start the clock. */
const IGNORED_MESSAGE_TYPES = new Set(['receipt', 'event']);
const IGNORED_MESSAGE_STATUSES = new Set(['removed']);

function toMs(value) {
  if (!value) return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function participantUserId(p) {
  return p?.userId || p?.user?.id || null;
}

function isAgentPurpose(p) {
  const purpose = String(p?.purpose || '').toLowerCase();
  return purpose === 'agent' || purpose === 'user';
}

function isCustomerPurpose(p) {
  const purpose = String(p?.purpose || '').toLowerCase();
  return purpose === 'customer' || purpose === 'external';
}

function heuristicDirection(status) {
  return INBOUND_STATUSES.has(String(status || '').toLowerCase()) ? 'inbound' : 'outbound';
}

/**
 * Derives the agent-side state of the conversation from the agent's own
 * participant(s): 'connected' | 'alerting' | 'wrapup' | 'ended' | 'none'.
 */
function deriveAgentState(myParticipants) {
  let state = 'none';
  let connectedAt = null;
  let wrapupPending = false;

  for (const p of myParticipants) {
    const comms = [...(p.messages || []), ...(p.chats || [])];
    for (const c of comms) {
      const s = String(c.state || '').toLowerCase();
      if (CONNECTED_STATES.has(s)) {
        state = 'connected';
        const at = toMs(c.connectedTime) ?? toMs(p.connectedTime);
        // Keep the most recent connection (covers consult/transfer-back scenarios).
        if (at && (!connectedAt || at > connectedAt)) connectedAt = at;
      } else if (ALERTING_STATES.has(s) && state !== 'connected') {
        state = 'alerting';
      }
    }
    if (p.wrapupRequired && !p.wrapup && !p.wrapupSkipped) wrapupPending = true;
  }

  if (state === 'none' && wrapupPending) state = 'wrapup';
  if (state === 'none' && myParticipants.length > 0) state = 'ended';
  return { state, connectedAt };
}

function pickMediaType(participants) {
  for (const p of participants) {
    for (const c of p.messages || []) {
      if (c.type) return String(c.type).toLowerCase();
    }
    if ((p.chats || []).length) return 'chat';
  }
  return null;
}

function pickCustomer(participants) {
  const customer = participants.find(isCustomerPurpose);
  if (!customer) return { name: 'Customer', address: null };
  const comm = (customer.messages || [])[0];
  const address = customer.address
    || comm?.fromAddress?.addressNormalized
    || comm?.fromAddress?.addressRaw
    || comm?.fromAddress?.name
    || null;
  return { name: customer.name || address || 'Customer', address };
}

export class ConversationTracker {
  /**
   * @param {object} opts
   * @param {string} opts.userId  The Genesys Cloud user id of the agent running the app.
   */
  constructor({ userId }) {
    if (!userId) throw new Error('ConversationTracker requires the agent userId');
    this.userId = userId;
    /** @type {Map<string, object>} conversationId -> entry */
    this.entries = new Map();
  }

  /**
   * Ingests a conversation object (REST or notification payload).
   * Returns the updated entry, or null if the conversation does not involve this agent.
   */
  ingest(conversation, receivedAt = Date.now()) {
    if (!conversation?.id || !Array.isArray(conversation.participants)) return null;
    const participants = conversation.participants;
    const mine = participants.filter((p) => isAgentPurpose(p) && participantUserId(p) === this.userId);

    if (mine.length === 0) {
      // Not (or no longer) our conversation: forget anything we had.
      this.entries.delete(conversation.id);
      return null;
    }

    const existing = this.entries.get(conversation.id);
    const entry = existing || {
      conversationId: conversation.id,
      messages: new Map(),
      customerName: 'Customer',
      customerAddress: null,
      mediaType: null,
      firstSeenAt: receivedAt
    };

    const { state, connectedAt } = deriveAgentState(mine);
    entry.state = state;
    entry.agentConnectedAt = connectedAt;
    entry.lastEventAt = receivedAt;
    entry.mediaType = pickMediaType(mine) || pickMediaType(participants) || entry.mediaType;
    const customer = pickCustomer(participants);
    entry.customerName = customer.name;
    entry.customerAddress = customer.address;

    // Collect every message detail we can see, from every participant.
    for (const p of participants) {
      for (const comm of p.messages || []) {
        for (const d of comm.messages || []) {
          this._recordMessageDetail(entry, d);
        }
      }
    }

    if (state === 'ended' && !existing) {
      // Nothing to track for a conversation that was already over when we first saw it.
      return null;
    }

    this.entries.set(conversation.id, entry);
    this._recompute(entry);
    return entry;
  }

  _recordMessageDetail(entry, d) {
    const id = d?.messageId;
    if (!id) return;
    const status = String(d.messageStatus || '').toLowerCase();
    const metaType = String(d.messageMetadata?.type || '').toLowerCase();
    if (IGNORED_MESSAGE_STATUSES.has(status)) {
      entry.messages.delete(id);
      return;
    }
    const time = toMs(d.messageTime);
    if (!time) return;
    const known = entry.messages.get(id);
    if (known?.source === 'api') {
      known.ignored = known.ignored || IGNORED_MESSAGE_TYPES.has(metaType);
      return; // authoritative data wins
    }
    const guess = heuristicDirection(status);
    // If the same id shows up under several participants, an explicit "received" wins.
    const direction = known && known.direction === 'inbound' ? 'inbound' : guess;
    entry.messages.set(id, {
      id,
      time,
      status,
      direction,
      source: 'heuristic',
      ignored: IGNORED_MESSAGE_TYPES.has(metaType),
      text: known?.text || null
    });
  }

  /**
   * Applies authoritative message data (from POST .../messages/bulk).
   * @param {string} conversationId
   * @param {Array<{id:string, direction?:string, timestamp?:string, text?:string|null, type?:string|null}>} details
   */
  applyMessageDetails(conversationId, details) {
    const entry = this.entries.get(conversationId);
    if (!entry) return;
    for (const d of details || []) {
      if (!d?.id) continue;
      const time = toMs(d.timestamp) ?? entry.messages.get(d.id)?.time;
      if (!time) continue;
      const direction = String(d.direction || '').toLowerCase() === 'inbound' ? 'inbound' : 'outbound';
      entry.messages.set(d.id, {
        id: d.id,
        time,
        status: entry.messages.get(d.id)?.status || null,
        direction,
        source: 'api',
        ignored: IGNORED_MESSAGE_TYPES.has(String(d.type || '').toLowerCase()),
        text: d.text ?? null
      });
    }
    this._recompute(entry);
  }

  /** Message ids whose direction has not been confirmed by the API yet. */
  unresolvedMessageIds(conversationId) {
    const entry = this.entries.get(conversationId);
    if (!entry) return [];
    return [...entry.messages.values()].filter((m) => m.source !== 'api').map((m) => m.id);
  }

  remove(conversationId) {
    this.entries.delete(conversationId);
  }

  /** Drops conversations that ended more than `maxAgeMs` ago. */
  prune(now = Date.now(), maxAgeMs = 5 * 60 * 1000) {
    for (const [id, e] of this.entries) {
      if ((e.state === 'ended' || e.state === 'none') && now - e.lastEventAt > maxAgeMs) {
        this.entries.delete(id);
      }
    }
  }

  _recompute(entry) {
    let lastInboundAt = null;
    let lastOutboundAt = null;
    let lastInbound = null;
    for (const m of entry.messages.values()) {
      if (m.ignored) continue;
      if (m.direction === 'inbound') {
        if (!lastInboundAt || m.time > lastInboundAt) {
          lastInboundAt = m.time;
          lastInbound = m;
        }
      } else if (!lastOutboundAt || m.time > lastOutboundAt) {
        lastOutboundAt = m.time;
      }
    }
    entry.lastInboundAt = lastInboundAt;
    entry.lastOutboundAt = lastOutboundAt;
    entry.lastInboundText = lastInbound?.text || null;
    Object.assign(entry, computeWaiting(entry));
  }

  /** Point-in-time view of every tracked conversation. */
  snapshot(now = Date.now()) {
    const rows = [];
    for (const e of this.entries.values()) {
      rows.push({
        conversationId: e.conversationId,
        customerName: e.customerName,
        customerAddress: e.customerAddress,
        mediaType: e.mediaType,
        state: e.state,
        agentConnectedAt: e.agentConnectedAt,
        lastInboundAt: e.lastInboundAt,
        lastOutboundAt: e.lastOutboundAt,
        lastInboundText: e.lastInboundText,
        waitingSince: e.waitingSince,
        awaiting: e.awaiting,
        waitMs: e.awaiting ? Math.max(0, now - e.waitingSince) : 0
      });
    }
    return rows;
  }
}

/**
 * The core rule, exported for unit tests.
 * @returns {{waitingSince: number|null, awaiting: boolean}}
 */
export function computeWaiting({ state, agentConnectedAt, lastInboundAt, lastOutboundAt }) {
  if (state !== 'connected' || !agentConnectedAt) {
    return { waitingSince: null, awaiting: false };
  }
  const waitingSince = Math.max(lastInboundAt ?? 0, agentConnectedAt);
  const answered = lastOutboundAt != null && lastOutboundAt >= waitingSince;
  return { waitingSince, awaiting: !answered };
}
