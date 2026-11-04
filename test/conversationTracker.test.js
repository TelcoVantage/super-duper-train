import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationTracker, computeWaiting } from '../src/core/conversationTracker.js';

const ME = 'agent-1';
const T0 = Date.parse('2026-01-01T10:00:00Z');
const iso = (offsetSec) => new Date(T0 + offsetSec * 1000).toISOString();

function conversation({ id = 'conv-1', agentState = 'connected', connectedAt = 0, customerMsgs = [], agentMsgs = [], wrapupRequired = false, userId = ME, purpose = 'agent' } = {}) {
  const detail = ([mid, at, status, type]) => ({ messageId: mid, messageTime: iso(at), messageStatus: status, messageMetadata: type ? { type } : undefined });
  return {
    id,
    participants: [
      { id: 'p-cust', purpose: 'customer', name: 'Jane Doe', messages: [{ id: 'c1', state: 'connected', type: 'webmessaging', messages: customerMsgs.map(detail) }] },
      { id: 'p-acd', purpose: 'acd', messages: [{ id: 'c2', state: 'disconnected', type: 'webmessaging', messages: [] }] },
      { id: 'p-agent', purpose, userId, wrapupRequired, messages: [{ id: 'c3', state: agentState, connectedTime: iso(connectedAt), type: 'webmessaging', messages: agentMsgs.map(detail) }] }
    ]
  };
}

test('computeWaiting: clock starts at the later of agent connect and last inbound', () => {
  assert.deepEqual(computeWaiting({ state: 'connected', agentConnectedAt: 100, lastInboundAt: 50, lastOutboundAt: null }), { waitingSince: 100, awaiting: true });
  assert.deepEqual(computeWaiting({ state: 'connected', agentConnectedAt: 100, lastInboundAt: 150, lastOutboundAt: null }), { waitingSince: 150, awaiting: true });
});

test('computeWaiting: an outbound reply after the inbound clears the wait', () => {
  assert.deepEqual(computeWaiting({ state: 'connected', agentConnectedAt: 100, lastInboundAt: 150, lastOutboundAt: 160 }), { waitingSince: 150, awaiting: false });
  // A bot reply from before the agent connected does not count.
  assert.deepEqual(computeWaiting({ state: 'connected', agentConnectedAt: 100, lastInboundAt: 50, lastOutboundAt: 60 }), { waitingSince: 100, awaiting: true });
});

test('computeWaiting: nothing is awaited unless the agent is connected', () => {
  for (const state of ['alerting', 'wrapup', 'ended', 'none']) {
    assert.equal(computeWaiting({ state, agentConnectedAt: 100, lastInboundAt: 150, lastOutboundAt: null }).awaiting, false);
  }
});

test('ingest: customer message after connect -> awaiting since that message', () => {
  const t = new ConversationTracker({ userId: ME });
  t.ingest(conversation({ connectedAt: 0, customerMsgs: [['m1', -30, 'received'], ['m2', 20, 'received']] }), T0 + 60_000);
  const [row] = t.snapshot(T0 + 60_000);
  assert.equal(row.awaiting, true);
  assert.equal(row.waitingSince, T0 + 20_000);
  assert.equal(row.waitMs, 40_000);
  assert.equal(row.customerName, 'Jane Doe');
  assert.equal(row.mediaType, 'webmessaging');
});

test('ingest: queue wait before connect is not charged to the agent', () => {
  const t = new ConversationTracker({ userId: ME });
  t.ingest(conversation({ connectedAt: 300, customerMsgs: [['m1', 0, 'received']] }), T0 + 310_000);
  const [row] = t.snapshot(T0 + 310_000);
  assert.equal(row.awaiting, true);
  assert.equal(row.waitingSince, T0 + 300_000);
  assert.equal(row.waitMs, 10_000);
});

test('ingest: agent reply (heuristic from status) clears the wait, next customer message restarts it', () => {
  const t = new ConversationTracker({ userId: ME });
  t.ingest(conversation({ customerMsgs: [['m1', 10, 'received']], agentMsgs: [['m2', 30, 'sent']] }));
  assert.equal(t.snapshot(T0 + 40_000)[0].awaiting, false);
  t.ingest(conversation({ customerMsgs: [['m1', 10, 'received'], ['m3', 50, 'received']], agentMsgs: [['m2', 30, 'sent']] }));
  const [row] = t.snapshot(T0 + 60_000);
  assert.equal(row.awaiting, true);
  assert.equal(row.waitingSince, T0 + 50_000);
});

test('ingest: receipts and removed messages never start the clock', () => {
  const t = new ConversationTracker({ userId: ME });
  t.ingest(conversation({ customerMsgs: [['m1', 10, 'received'], ['r1', 40, 'received', 'Receipt']], agentMsgs: [['m2', 30, 'sent']] }));
  assert.equal(t.snapshot(T0 + 60_000)[0].awaiting, false, 'read receipt must not look like a new customer message');
  t.ingest(conversation({ customerMsgs: [['m1', 10, 'received'], ['m9', 50, 'removed']], agentMsgs: [['m2', 30, 'sent']] }));
  assert.equal(t.snapshot(T0 + 60_000)[0].awaiting, false);
});

test('applyMessageDetails: API direction overrides the heuristic and supplies preview text', () => {
  const t = new ConversationTracker({ userId: ME });
  // Status says "sent" (would be guessed outbound) but the API says it was inbound.
  t.ingest(conversation({ customerMsgs: [['m1', 10, 'sent']] }));
  assert.equal(t.snapshot(T0 + 20_000)[0].awaiting, false);
  assert.deepEqual(t.unresolvedMessageIds('conv-1'), ['m1']);
  t.applyMessageDetails('conv-1', [{ id: 'm1', direction: 'inbound', timestamp: iso(10), text: 'Hello?', type: 'Text' }]);
  const [row] = t.snapshot(T0 + 20_000);
  assert.equal(row.awaiting, true);
  assert.equal(row.lastInboundText, 'Hello?');
  assert.deepEqual(t.unresolvedMessageIds('conv-1'), []);
  // A later event must not downgrade the API-confirmed direction.
  t.ingest(conversation({ customerMsgs: [['m1', 10, 'sent']] }));
  assert.equal(t.snapshot(T0 + 20_000)[0].awaiting, true);
});

test('ingest: alerting / wrap-up / ended states are not awaiting; ended conversations get pruned', () => {
  const t = new ConversationTracker({ userId: ME });
  t.ingest(conversation({ agentState: 'alerting', customerMsgs: [['m1', 0, 'received']] }), T0);
  assert.equal(t.snapshot(T0 + 10_000)[0].awaiting, false);
  assert.equal(t.snapshot(T0 + 10_000)[0].state, 'alerting');

  t.ingest(conversation({ agentState: 'disconnected', wrapupRequired: true, customerMsgs: [['m1', 0, 'received']] }), T0 + 20_000);
  assert.equal(t.snapshot(T0 + 20_000)[0].state, 'wrapup');
  assert.equal(t.snapshot(T0 + 20_000)[0].awaiting, false);

  t.ingest(conversation({ agentState: 'disconnected', customerMsgs: [['m1', 0, 'received']] }), T0 + 30_000);
  assert.equal(t.snapshot(T0 + 30_000)[0].state, 'ended');
  t.prune(T0 + 30_000 + 6 * 60_000);
  assert.equal(t.snapshot().length, 0);
});

test('ingest: conversations that never involved this agent are ignored, and transfers away remove them', () => {
  const t = new ConversationTracker({ userId: ME });
  assert.equal(t.ingest(conversation({ userId: 'someone-else' })), null);
  assert.equal(t.snapshot().length, 0);
  t.ingest(conversation({ customerMsgs: [['m1', 0, 'received']] }));
  assert.equal(t.snapshot().length, 1);
  t.ingest(conversation({ userId: 'someone-else' }));
  assert.equal(t.snapshot().length, 0);
});

test('ingest: "user" purpose (direct, non-ACD) participants are tracked too', () => {
  const t = new ConversationTracker({ userId: ME });
  t.ingest(conversation({ purpose: 'user', customerMsgs: [['m1', 5, 'received']] }));
  assert.equal(t.snapshot(T0 + 10_000)[0].awaiting, true);
});
