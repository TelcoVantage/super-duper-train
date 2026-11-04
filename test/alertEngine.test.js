import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlertEngine } from '../src/core/alertEngine.js';

const SETTINGS = { warnAfterSec: 30, criticalAfterSec: 60, repeatEverySec: 60, snoozeSec: 120, toasts: true, resolvedToasts: true, sounds: true, badge: true, showPreview: true };

function harness(settings = SETTINGS) {
  const calls = { toast: [], sound: [], badge: [], flash: [] };
  const engine = new AlertEngine({
    settings,
    effects: {
      toast: (t) => calls.toast.push(t),
      sound: (l) => calls.sound.push(l),
      badge: (n) => calls.badge.push(n),
      flash: (f) => calls.flash.push(f)
    }
  });
  return { engine, calls };
}

const T0 = 1_000_000;
/** A connected conversation whose customer has been waiting since `since` (ms), seen at time `now`. */
const waiting = (id, since, now) => ({
  conversationId: id, customerName: 'Jane', mediaType: 'sms', state: 'connected',
  awaiting: true, waitingSince: since, waitMs: now - since
});
/** A connected conversation the agent has replied to. */
const replied = (id) => ({ conversationId: id, customerName: 'Jane', mediaType: 'sms', state: 'connected', awaiting: false, waitingSince: T0, waitMs: 0 });
const at = (sec) => T0 + sec * 1000;

test('escalates ok -> warn -> critical with one toast + sound per step and a badge count', () => {
  const { engine, calls } = harness();
  let out = engine.evaluate([waiting('a', T0, at(10))], at(10));
  assert.equal(out[0].level, 'ok');
  assert.equal(calls.toast.length, 0);
  assert.deepEqual(calls.badge, [0]);

  out = engine.evaluate([waiting('a', T0, at(31))], at(31));
  assert.equal(out[0].level, 'warn');
  assert.equal(out[0].waitSec, 31);
  assert.equal(calls.toast.length, 1);
  assert.equal(calls.toast[0].level, 'warn');
  assert.deepEqual(calls.sound, ['warn']);
  assert.deepEqual(calls.badge, [0, 1]);
  assert.deepEqual(calls.flash, [false, true]);

  out = engine.evaluate([waiting('a', T0, at(45))], at(45));
  assert.equal(calls.toast.length, 1, 'no repeat while still at warn');

  out = engine.evaluate([waiting('a', T0, at(61))], at(61));
  assert.equal(out[0].level, 'critical');
  assert.equal(calls.toast.length, 2);
  assert.equal(calls.toast[1].level, 'critical');
  assert.deepEqual(calls.badge, [0, 1], 'badge count unchanged (still one conversation)');
});

test('critical reminders repeat every repeatEverySec and stop when repeat is 0', () => {
  const { engine, calls } = harness();
  engine.evaluate([waiting('a', T0, at(61))], at(61));
  engine.evaluate([waiting('a', T0, at(90))], at(90));
  assert.equal(calls.toast.length, 1, 'not yet due');
  engine.evaluate([waiting('a', T0, at(122))], at(122));
  assert.equal(calls.toast.length, 2, 'repeat fired after 60s');
  assert.equal(calls.toast[1].level, 'critical');

  const quiet = harness({ ...SETTINGS, repeatEverySec: 0 });
  quiet.engine.evaluate([waiting('a', T0, at(61))], at(61));
  quiet.engine.evaluate([waiting('a', T0, at(600))], at(600));
  assert.equal(quiet.calls.toast.length, 1);
});

test('agent reply clears the alert with a resolved toast and badge back to 0', () => {
  const { engine, calls } = harness();
  engine.evaluate([waiting('a', T0, at(61))], at(61));
  const out = engine.evaluate([replied('a')], at(62));
  assert.equal(out[0].level, 'ok');
  assert.equal(calls.toast.at(-1).level, 'resolved');
  assert.equal(calls.badge.at(-1), 0);
  assert.equal(calls.flash.at(-1), false);
  // A reply before any alert fired must not produce a resolved toast.
  const fresh = harness();
  fresh.engine.evaluate([waiting('b', T0, at(5))], at(5));
  fresh.engine.evaluate([replied('b')], at(6));
  assert.equal(fresh.calls.toast.length, 0);
});

test('conversation that disappears after an alert emits a resolved toast and drops its state', () => {
  const { engine, calls } = harness();
  engine.evaluate([waiting('a', T0, at(40))], at(40));
  engine.evaluate([], at(41));
  assert.equal(calls.toast.at(-1).level, 'resolved');
  assert.equal(engine.state.size, 0);
});

test('snooze silences a conversation until a NEW customer message arrives', () => {
  const { engine, calls } = harness();
  engine.evaluate([waiting('a', T0, at(61))], at(61));
  engine.snooze('a', at(61));
  let out = engine.evaluate([waiting('a', T0, at(62))], at(62));
  assert.equal(out[0].level, 'snoozed');
  assert.equal(calls.badge.at(-1), 0, 'snoozed conversations do not count for the badge');
  out = engine.evaluate([waiting('a', T0, at(130))], at(130));
  assert.equal(out[0].level, 'snoozed', 'still snoozed, no repeat');
  assert.equal(calls.toast.length, 1);

  // New inbound message at t=100s: waitingSince moves -> snooze cancelled -> alert again once past warn.
  out = engine.evaluate([waiting('a', at(100), at(131))], at(131));
  assert.equal(out[0].level, 'warn');
  assert.equal(calls.toast.length, 2);
  assert.equal(engine.isSnoozed('a', at(131)), false);
});

test('snooze expires after snoozeSec', () => {
  const { engine } = harness();
  engine.evaluate([waiting('a', T0, at(61))], at(61));
  engine.snooze('a', at(61));
  assert.equal(engine.evaluate([waiting('a', T0, at(180))], at(180))[0].level, 'snoozed');
  assert.equal(engine.evaluate([waiting('a', T0, at(182))], at(182))[0].level, 'critical');
});

test('a new customer message after an alert re-alerts even without a level change', () => {
  const { engine, calls } = harness();
  engine.evaluate([waiting('a', T0, at(31))], at(31));
  assert.equal(calls.toast.length, 1);
  // Customer wrote again at t=10s (agent still silent); still warn level, but it is a new message.
  engine.evaluate([waiting('a', at(10), at(45))], at(45));
  assert.equal(calls.toast.length, 2);
});

test('rows are sorted by severity then wait time; toasts can be disabled', () => {
  const { engine, calls } = harness({ ...SETTINGS, toasts: false });
  const now = at(100);
  const out = engine.evaluate([waiting('a', at(90), now), waiting('b', at(30), now), waiting('c', at(60), now), waiting('d', at(35), now)], now);
  assert.deepEqual(out.map((r) => r.conversationId), ['b', 'd', 'c', 'a']);
  assert.equal(calls.toast.length, 0, 'toasts disabled');
  assert.deepEqual([...calls.sound].sort(), ['critical', 'critical', 'warn'], 'sound still fires');
  assert.equal(calls.badge.at(-1), 3);
});
