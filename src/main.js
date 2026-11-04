/**
 * Reply Radar – entry point.
 *
 * Boot sequence:
 *   1. restore the integration query string if we are returning from OAuth
 *   2. hand-shake with the Genesys Cloud host (Client App SDK)
 *   3. log in with the agent's session (Implicit Grant), look up "me"
 *   4. initial REST sync of the agent's active conversations
 *   5. subscribe to v2.users.{me}.conversations over WebSocket
 *   6. tick once a second: tracker -> engine -> UI / toasts / badge / sound
 */
import { restoreQueryAfterRedirect, initPlatform, getMe, listActiveConversations, getConversation, fetchMessageDetails } from './genesys/platform.js';
import { createClientApp } from './genesys/clientApp.js';
import { NotificationChannel, userConversationsTopic } from './genesys/notifications.js';
import { ConversationTracker } from './core/conversationTracker.js';
import { AlertEngine } from './core/alertEngine.js';
import { formatDuration, channelLabel, truncate } from './core/format.js';
import { resolveSettings, resolveRuntimeConfig, saveStoredSettings, clearStoredSettings, DEFAULTS } from './config.js';
import { createPanel } from './ui/panel.js';
import * as sound from './sound.js';

const APP_VERSION = '1.0.0';

restoreQueryAfterRedirect();

const runtime = resolveRuntimeConfig();
let settings = resolveSettings();
const log = (...args) => { if (settings.debug) console.log('[ReplyRadar]', ...args); };

const gc = createClientApp({ defaultEnvironment: runtime.defaultEnvironment });
const root = document.getElementById('app');
let tracker = null;
let engine = null;
let channel = null;
let apis = null;
let me = null;
let lastSyncAt = null;
let tickTimer = null;
let resyncTimer = null;
const pendingLookups = new Map(); // conversationId -> timeout handle

const panel = createPanel({
  root,
  onJump: (id) => gc.jumpTo(id),
  onSnooze: (id) => { engine?.snooze(id); tick(); },
  onUnsnooze: (id) => { engine?.unsnooze(id); tick(); },
  onSaveSettings: (next) => { settings = next; saveStoredSettings(settings); engine?.updateSettings(settings); scheduleResync(); tick(); },
  onResetSettings: () => { clearStoredSettings(); settings = resolveSettings(); engine?.updateSettings(settings); scheduleResync(); tick(); },
  onTestAlert: () => {
    gc.toast({ id: 'test', level: 'critical', title: 'Reply Radar test', message: 'This is what a **critical** unanswered-chat alert looks like. Close it with the ✕.' });
    if (settings.badge) gc.badge(1);
    if (settings.sounds) sound.play('critical');
    setTimeout(() => { if (settings.badge) gc.badge(engine?.lastBadge || 0); }, 4000);
  },
  onResync: () => resync('manual')
});

// Browser autoplay rules: sound works only after the agent has interacted with the page once.
panel.setSoundLocked(true);
const unlockSound = async () => { if (await sound.unlock()) { panel.setSoundLocked(false); tick(); } };
['pointerdown', 'keydown', 'touchstart'].forEach((evt) => document.addEventListener(evt, unlockSound, { passive: true }));
sound.unlock().then((ok) => { if (ok) panel.setSoundLocked(false); });

// ---- Genesys Cloud host lifecycle ------------------------------------------------
gc.onBootstrap(() => gc.bootstrapped());
gc.onFocus(() => { log('focus'); resync('focus'); });
gc.onStop(() => { shutdown(); gc.stopped(); });
window.addEventListener('beforeunload', shutdown);
window.addEventListener('online', () => resync('online'));

if (!gc.embedded) {
  panel.setStatus('connecting', 'Standalone');
}

// ---- Alert effects -------------------------------------------------------------
function toastFor({ conversationId, level, row }) {
  if (level === 'resolved') {
    gc.toast({ id: conversationId, level: 'resolved', timeoutSec: 4, title: 'Reply sent ✓', message: row ? `${row.customerName} is no longer waiting.` : 'Conversation cleared.' });
    return;
  }
  const who = row.customerName || 'Customer';
  const chan = channelLabel(row.mediaType);
  const waited = formatDuration(row.waitMs);
  const preview = settings.showPreview && row.lastInboundText ? `\n\n> ${truncate(row.lastInboundText, 120)}` : '';
  const title = level === 'critical' ? `⚠️ ${who} has waited ${waited}` : `💬 ${who} is waiting (${waited})`;
  const message = `**${chan}** interaction has no reply from you.${preview}\n\nOpen **Reply Radar** in the sidebar and press *Open interaction* to jump to it.`;
  gc.toast({ id: conversationId, level, title, message, timeoutSec: 10 });
}

function buildEngine() {
  return new AlertEngine({
    settings,
    effects: {
      toast: toastFor,
      sound: (level) => { if (settings.sounds) sound.play(level); },
      badge: (count) => { if (settings.badge) gc.badge(count); else gc.badge(0); },
      flash: (active) => panel.setFlashing(active)
    }
  });
}

// ---- Conversation ingestion ----------------------------------------------------
function ingestConversation(conv, source) {
  const entry = tracker.ingest(conv);
  log('ingest', source, conv.id, entry ? `${entry.state} awaiting=${entry.awaiting}` : 'ignored');
  if (entry) scheduleDirectionLookup(conv.id);
}

/** Confirms message directions via the bulk endpoint (debounced per conversation). */
function scheduleDirectionLookup(conversationId) {
  clearTimeout(pendingLookups.get(conversationId));
  pendingLookups.set(conversationId, setTimeout(async () => {
    pendingLookups.delete(conversationId);
    const ids = tracker.unresolvedMessageIds(conversationId);
    if (!ids.length) return;
    try {
      const details = await fetchMessageDetails(apis.conversationsApi, conversationId, ids);
      tracker.applyMessageDetails(conversationId, details);
      tick();
    } catch (err) {
      // Heuristic directions stay in place; alerts still work.
      log('bulk message lookup failed (heuristics kept)', conversationId, err?.message || err);
    }
  }, 400));
}

async function resync(reason) {
  if (!apis || !tracker) return;
  try {
    const conversations = await listActiveConversations(apis.conversationsApi);
    const seen = new Set(conversations.map((c) => c.id));
    for (const c of conversations) ingestConversation(c, `resync:${reason}`);
    // Anything we track that the API no longer lists is over.
    for (const id of [...tracker.entries.keys()]) if (!seen.has(id)) tracker.remove(id);
    lastSyncAt = Date.now();
    tick();
  } catch (err) {
    log('resync failed', reason, err?.message || err);
    if (err?.status === 401) panel.setStatus('error', 'Session expired – reopen the app');
  }
}

function scheduleResync() {
  clearInterval(resyncTimer);
  const every = Math.max(15, Number(settings.resyncEverySec) || DEFAULTS.resyncEverySec) * 1000;
  resyncTimer = setInterval(() => resync('timer'), every);
}

function onNotification(topic, body) {
  if (!body?.id) return;
  if (!Array.isArray(body.participants)) {
    // Defensive: unexpected shape, fetch the full conversation instead.
    getConversation(apis.conversationsApi, body.id).then((c) => { ingestConversation(c, 'fetch'); tick(); }).catch(() => {});
    return;
  }
  ingestConversation(body, 'event');
  tick();
}

// ---- Tick ----------------------------------------------------------------------
function tick() {
  if (!tracker || !engine) return;
  const now = Date.now();
  tracker.prune(now);
  const rows = engine.evaluate(tracker.snapshot(now), now);
  panel.render(rows, settings);
  panel.setFooter({ agentName: me?.name, environment: gc.environment, lastSyncAt, version: APP_VERSION });
}

function shutdown() {
  clearInterval(tickTimer);
  clearInterval(resyncTimer);
  for (const t of pendingLookups.values()) clearTimeout(t);
  channel?.stop();
  try { gc.badge(0); } catch { /* host gone */ }
}

// ---- Boot ----------------------------------------------------------------------
async function boot() {
  try {
    panel.setStatus('connecting', 'Signing in…');
    apis = await initPlatform({ clientId: runtime.clientId, environment: gc.environment, usePopupAuth: runtime.usePopupAuth });
    me = await getMe(apis.usersApi);
    log('signed in as', me);

    tracker = new ConversationTracker({ userId: me.id });
    engine = buildEngine();

    panel.setStatus('connecting', 'Loading interactions…');
    await resync('initial');

    channel = new NotificationChannel({
      notificationsApi: apis.notificationsApi,
      topics: [userConversationsTopic(me.id)],
      onEvent: onNotification,
      onStatus: (state, detail) => {
        const labels = { connecting: 'Connecting…', connected: 'Live', reconnecting: 'Reconnecting…', stopped: 'Stopped' };
        panel.setStatus(state, labels[state] || state);
        if (detail) log('channel status', state, detail);
      },
      onReconnect: () => resync('reconnect'),
      log
    });
    await channel.start();

    tickTimer = setInterval(tick, 1000);
    scheduleResync();
    tick();
  } catch (err) {
    console.error('[ReplyRadar] boot failed', err);
    const msg = err?.message || String(err);
    let hint = '';
    if (/client id/i.test(msg)) hint = 'An admin must add <code>clientId=&lt;OAuth client id&gt;</code> to the Client Application integration URL. See docs/genesys-cloud-setup.md.';
    else if (err?.status === 401 || /unauthorized|invalid_client|redirect/i.test(msg)) hint = 'Check that the OAuth client is a <strong>Token Implicit Grant (Browser)</strong> client and that this page URL is listed as an authorized redirect URI.';
    else if (err?.status === 403) hint = 'The agent role needs the <code>conversation:communication:view</code> permission (or the OAuth client is missing the scopes listed in the docs).';
    panel.renderError(msg, hint);
  }
}

// ---- Demo mode (no Genesys org needed) -------------------------------------------
async function bootDemo() {
  me = { id: 'demo-agent', name: 'Demo Agent' };
  tracker = new ConversationTracker({ userId: me.id });
  engine = buildEngine();
  const start = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const conv = (id, name, type, connectedAt, inbound, outbound) => ({
    id,
    participants: [
      { id: `${id}-c`, purpose: 'customer', name, messages: [{ id: `${id}-cc`, state: 'connected', type, messages: inbound.map(([mid, t, text]) => ({ messageId: mid, messageTime: iso(t), messageStatus: 'received', messageMetadata: { type: 'Text', content: text } })) }] },
      { id: `${id}-a`, purpose: 'agent', userId: me.id, messages: [{ id: `${id}-ac`, state: 'connected', type, connectedTime: iso(connectedAt), messages: outbound.map(([mid, t]) => ({ messageId: mid, messageTime: iso(t), messageStatus: 'sent' })) }] }
    ]
  });
  const feed = (c, texts) => {
    tracker.ingest(c);
    tracker.applyMessageDetails(c.id, texts.map(([id, text, t]) => ({ id, direction: 'inbound', timestamp: iso(t), text, type: 'Text' })));
  };
  feed(conv('demo-1', 'Priya Natarajan', 'webmessaging', start - 95_000, [['m1', start - 95_000, 'Hi, my order 48213 still shows "processing". Can you check?']], []), [['m1', 'Hi, my order 48213 still shows "processing". Can you check?', start - 95_000]]);
  feed(conv('demo-2', '+44 7700 900123', 'sms', start - 240_000, [['m2', start - 240_000, 'Can I change my delivery slot?'], ['m3', start - 20_000, 'Hello? Anyone there?']], [['m4', start - 200_000]]), [['m3', 'Hello? Anyone there?', start - 20_000]]);
  feed(conv('demo-3', 'Marco Rossi', 'whatsapp', start - 400_000, [['m5', start - 300_000, 'Thanks, that fixed it!']], [['m6', start - 290_000]]), []);
  panel.setStatus('connected', 'Demo');
  lastSyncAt = Date.now();
  tickTimer = setInterval(tick, 1000);
  tick();
  // Every 45s the happy customer writes again, so the demo keeps producing alerts.
  setInterval(() => {
    const t = Date.now();
    const id = `m-${t}`;
    feed(conv('demo-3', 'Marco Rossi', 'whatsapp', start - 400_000, [['m5', start - 300_000, ''], [id, t, 'One more thing…']], [['m6', start - 290_000]]), [[id, 'One more thing…', t]]);
    tick();
  }, 45_000);
}

if (runtime.demo) bootDemo(); else boot();
