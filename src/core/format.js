/**
 * Small, dependency-free formatting helpers shared by the engine and the UI.
 */

/** Formats a duration in milliseconds as "45s", "1m 30s" or "1h 02m". */
export function formatDuration(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** Formats a timestamp (ms) as a short local time, e.g. "14:05:31". */
export function formatClock(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const CHANNEL_LABELS = {
  webmessaging: 'Web Messaging',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  facebook: 'Facebook',
  instagram: 'Instagram',
  twitter: 'X / Twitter',
  line: 'LINE',
  telegram: 'Telegram',
  apple: 'Apple Messages',
  open: 'Open Messaging',
  chat: 'Web Chat (legacy)'
};

/** Human label for a Genesys message communication `type` (e.g. "webmessaging"). */
export function channelLabel(type) {
  if (!type) return 'Message';
  return CHANNEL_LABELS[String(type).toLowerCase()] || type;
}

/** Escapes text for safe insertion into innerHTML. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Truncates a string to `max` characters, adding an ellipsis. */
export function truncate(value, max = 80) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
