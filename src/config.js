/**
 * Settings resolution, lowest to highest priority:
 *
 *   1. DEFAULTS (below)
 *   2. Build-time env (VITE_GC_CLIENT_ID, VITE_GC_DEFAULT_ENVIRONMENT)
 *   3. Query parameters on the Client Application integration URL
 *      (lets an admin tune thresholds for everyone without a rebuild), e.g.
 *      ?clientId=...&warn=45&critical=90&repeat=30&sound=1&preview=0
 *   4. The agent's own choices saved from the settings panel (localStorage)
 */

export const DEFAULTS = Object.freeze({
  /** Seconds a customer may wait before the first (soft) alert. */
  warnAfterSec: 45,
  /** Seconds before the alert becomes critical (sticky toast + repeat reminders). */
  criticalAfterSec: 90,
  /** While critical, remind again every N seconds (0 disables repeats). */
  repeatEverySec: 60,
  /** Length of a snooze started from the panel. */
  snoozeSec: 120,
  /** Genesys Cloud toast pop-ups. */
  toasts: true,
  /** Short "replied" toast that replaces a sticky alert once the agent answers. */
  resolvedToasts: true,
  /** Audible beep (needs one click in the app after login because of browser autoplay rules). */
  sounds: true,
  /** Sidebar badge / attention counter on the app icon. */
  badge: true,
  /** Show the customer's last message text in the panel and toast. */
  showPreview: true,
  /** Safety-net REST re-sync interval in seconds (also runs after every WebSocket reconnect). */
  resyncEverySec: 60,
  /** Verbose console logging. */
  debug: false
});

const QUERY_ALIASES = {
  warn: 'warnAfterSec',
  critical: 'criticalAfterSec',
  repeat: 'repeatEverySec',
  snooze: 'snoozeSec',
  sound: 'sounds',
  sounds: 'sounds',
  toasts: 'toasts',
  badge: 'badge',
  preview: 'showPreview',
  resync: 'resyncEverySec',
  debug: 'debug'
};

export const STORAGE_KEY = 'replyRadar.settings.v1';

function coerce(key, raw) {
  const def = DEFAULTS[key];
  if (typeof def === 'boolean') return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
  if (typeof def === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : def;
  }
  return raw;
}

export function readQueryOverrides(search = globalThis.location?.search || '') {
  const q = new URLSearchParams(search);
  const out = {};
  for (const [alias, key] of Object.entries(QUERY_ALIASES)) {
    if (q.has(alias)) out[key] = coerce(key, q.get(alias));
  }
  return out;
}

export function readStoredSettings(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const out = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (key in parsed) out[key] = coerce(key, parsed[key]);
    }
    return out;
  } catch {
    return {};
  }
}

export function saveStoredSettings(settings, storage = globalThis.localStorage) {
  try {
    const subset = {};
    for (const key of Object.keys(DEFAULTS)) subset[key] = settings[key];
    storage?.setItem(STORAGE_KEY, JSON.stringify(subset));
  } catch {
    /* private mode / blocked storage: settings simply do not persist */
  }
}

export function clearStoredSettings(storage = globalThis.localStorage) {
  try { storage?.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

/** Resolves the effective settings object. */
export function resolveSettings({ search, storage } = {}) {
  const merged = { ...DEFAULTS, ...readQueryOverrides(search), ...readStoredSettings(storage) };
  if (merged.criticalAfterSec && merged.warnAfterSec && merged.criticalAfterSec < merged.warnAfterSec) {
    merged.criticalAfterSec = merged.warnAfterSec;
  }
  return merged;
}

/** Non-tunable runtime configuration (identity of the app, OAuth client, region). */
export function resolveRuntimeConfig(search = globalThis.location?.search || '') {
  const q = new URLSearchParams(search);
  const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};
  return {
    clientId: q.get('clientId') || env.VITE_GC_CLIENT_ID || '',
    defaultEnvironment: q.get('pcEnvironment') || env.VITE_GC_DEFAULT_ENVIRONMENT || 'mypurecloud.com',
    usePopupAuth: ['1', 'true'].includes(String(q.get('gcUsePopupAuth') || '').toLowerCase()),
    langTag: q.get('gcLangTag') || q.get('langTag') || q.get('pcLangTag') || 'en-US',
    /** ?demo=1 runs the panel with synthetic conversations and no Genesys login (for previews/training). */
    demo: ['1', 'true'].includes(String(q.get('demo') || '').toLowerCase())
  };
}
