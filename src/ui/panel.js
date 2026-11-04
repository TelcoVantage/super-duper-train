/**
 * The in-app panel the agent sees when they open Reply Radar in the sidebar.
 * Plain DOM, no framework: it re-renders once a second with the latest timers.
 */
import { formatDuration, formatClock, channelLabel, escapeHtml, truncate } from '../core/format.js';
import { DEFAULTS } from '../config.js';

const STATE_LABEL = {
  connected: 'connected',
  alerting: 'ringing',
  wrapup: 'wrap-up',
  ended: 'ended',
  none: ''
};

export function createPanel({ root, onJump, onSnooze, onUnsnooze, onSaveSettings, onResetSettings, onTestAlert, onResync }) {
  const main = root.querySelector('#main');
  const status = root.querySelector('#status');
  const footer = root.querySelector('#footer');
  let settingsOpen = false;
  let lastSettings = null;
  let soundLocked = false;

  function setStatus(state, text) {
    status.dataset.state = state;
    status.textContent = text;
  }

  function setFooter({ agentName, environment, lastSyncAt, version }) {
    footer.innerHTML = `
      <span>${escapeHtml(agentName || '')}${environment ? ` · ${escapeHtml(environment)}` : ''}</span>
      <span>last sync ${escapeHtml(formatClock(lastSyncAt) || '—')} · v${escapeHtml(version)}</span>`;
  }

  function setFlashing(active) {
    root.classList.toggle('is-flashing', !!active);
  }

  function setSoundLocked(locked) {
    soundLocked = locked;
  }

  function renderError(message, hint) {
    setStatus('error', 'Error');
    main.innerHTML = `
      <div class="error">
        <strong>Reply Radar could not start.</strong>
        <p><code>${escapeHtml(message)}</code></p>
        ${hint ? `<p class="note">${hint}</p>` : ''}
        <button id="retry">Retry</button>
      </div>`;
    main.querySelector('#retry')?.addEventListener('click', () => location.reload());
  }

  function rowHtml(row, settings) {
    const level = row.awaiting ? row.level : 'idle';
    const waitText = row.awaiting ? formatDuration(row.waitMs) : (row.state === 'connected' ? 'replied' : STATE_LABEL[row.state] || '');
    const since = row.awaiting ? `since ${formatClock(row.waitingSince)}` : (row.lastOutboundAt ? `last reply ${formatClock(row.lastOutboundAt)}` : '');
    const preview = settings.showPreview && row.lastInboundText ? `<div class="row__preview">“${escapeHtml(truncate(row.lastInboundText, 110))}”</div>` : '';
    const snoozeBtn = row.level === 'snoozed'
      ? `<button class="ghost" data-action="unsnooze" data-id="${row.conversationId}">Un-snooze (${formatDuration(row.snoozedUntil - Date.now())} left)</button>`
      : (row.awaiting ? `<button class="ghost" data-action="snooze" data-id="${row.conversationId}">Snooze ${formatDuration(settings.snoozeSec * 1000)}</button>` : '');
    return `
      <li class="row" data-level="${level}" data-id="${row.conversationId}">
        <div class="row__who">
          <span>${escapeHtml(row.customerName)}</span>
          <span class="badge">${escapeHtml(channelLabel(row.mediaType))}</span>
          ${row.level === 'critical' ? '<span class="badge" style="background:var(--critical);color:#fff">needs reply</span>' : ''}
          ${row.level === 'snoozed' ? '<span class="badge" style="background:var(--snoozed);color:#fff">snoozed</span>' : ''}
        </div>
        <div class="row__timer"><div class="big">${escapeHtml(waitText)}</div><div class="small">${escapeHtml(since)}</div></div>
        ${preview}
        <div class="row__actions">
          <button class="primary" data-action="jump" data-id="${row.conversationId}">Open interaction</button>
          ${snoozeBtn}
        </div>
      </li>`;
  }

  function settingsHtml(s) {
    const num = (key, label, hint) => `
      <label class="field"><span>${label}${hint ? ` <span class="note">(${hint})</span>` : ''}</span>
        <input type="number" min="0" step="5" name="${key}" value="${Number(s[key])}" /></label>`;
    const bool = (key, label) => `
      <label class="field field--check"><span>${label}</span>
        <input type="checkbox" name="${key}" ${s[key] ? 'checked' : ''} /></label>`;
    return `
      <details class="settings" ${settingsOpen ? 'open' : ''} id="settings">
        <summary>Settings</summary>
        <div class="settings__body">
          <form id="settings-form">
            ${num('warnAfterSec', 'First alert after (seconds)')}
            ${num('criticalAfterSec', 'Critical alert after (seconds)', 'sticky pop-up')}
            ${num('repeatEverySec', 'Repeat critical reminder every (seconds)', '0 = off')}
            ${num('snoozeSec', 'Snooze length (seconds)')}
            ${bool('toasts', 'Pop-up (toast) alerts')}
            ${bool('resolvedToasts', 'Show a short “replied” toast when cleared')}
            ${bool('sounds', 'Sound')}
            ${bool('badge', 'Badge on the sidebar icon')}
            ${bool('showPreview', 'Show the customer’s last message text')}
            <div class="settings__actions">
              <button type="submit" class="primary">Save</button>
              <button type="button" id="reset-settings" class="ghost">Reset to defaults</button>
              <button type="button" id="test-alert" class="ghost">Test alert</button>
              <button type="button" id="resync" class="ghost">Re-sync now</button>
            </div>
            <p class="note">Defaults: ${DEFAULTS.warnAfterSec}s / ${DEFAULTS.criticalAfterSec}s. Your choices are saved in this browser only.</p>
          </form>
        </div>
      </details>`;
  }

  function render(rows, settings) {
    lastSettings = settings;
    const awaiting = rows.filter((r) => r.awaiting);
    const warn = awaiting.filter((r) => r.level === 'warn').length;
    const critical = awaiting.filter((r) => r.level === 'critical').length;
    const active = rows.filter((r) => r.state === 'connected' || r.state === 'alerting');

    const summary = `
      <div class="summary">
        <span class="chip"><strong>${active.length}</strong> active</span>
        <span class="chip"><strong>${awaiting.length}</strong> awaiting reply</span>
        ${warn ? `<span class="chip chip--warn"><strong>${warn}</strong> waiting</span>` : ''}
        ${critical ? `<span class="chip chip--critical"><strong>${critical}</strong> critical</span>` : ''}
      </div>`;

    const soundHint = settings.sounds && soundLocked
      ? '<p class="sound-hint">🔇 Click anywhere in this panel once to enable sound alerts (browser rule).</p>'
      : '';

    const list = rows.length
      ? `<ul class="list">${rows.map((r) => rowHtml(r, settings)).join('')}</ul>`
      : `<div class="empty"><div class="big">🟢</div>No chats or messages assigned to you right now.</div>`;

    const open = main.querySelector('#settings')?.open;
    if (open !== undefined) settingsOpen = open;
    main.innerHTML = summary + soundHint + list + settingsHtml(settings);
  }

  main.addEventListener('click', (evt) => {
    const btn = evt.target.closest('button[data-action]');
    if (btn) {
      const { action, id } = btn.dataset;
      if (action === 'jump') onJump(id);
      if (action === 'snooze') onSnooze(id);
      if (action === 'unsnooze') onUnsnooze(id);
      return;
    }
    if (evt.target.id === 'reset-settings') onResetSettings();
    if (evt.target.id === 'test-alert') onTestAlert();
    if (evt.target.id === 'resync') onResync();
  });

  main.addEventListener('submit', (evt) => {
    if (evt.target.id !== 'settings-form') return;
    evt.preventDefault();
    const form = new FormData(evt.target);
    const next = { ...lastSettings };
    for (const key of Object.keys(DEFAULTS)) {
      const def = DEFAULTS[key];
      if (typeof def === 'boolean') next[key] = form.get(key) === 'on';
      else if (typeof def === 'number') {
        const n = Number(form.get(key));
        next[key] = Number.isFinite(n) && n >= 0 ? n : def;
      }
    }
    if (next.criticalAfterSec < next.warnAfterSec) next.criticalAfterSec = next.warnAfterSec;
    onSaveSettings(next);
  });

  main.addEventListener('toggle', (evt) => {
    if (evt.target.id === 'settings') settingsOpen = evt.target.open;
  }, true);

  return { render, renderError, setStatus, setFooter, setFlashing, setSoundLocked };
}
