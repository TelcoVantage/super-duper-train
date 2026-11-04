/**
 * AlertEngine
 * -----------
 * Turns the tracker's "who is waiting, since when" snapshot into agent-facing
 * alerts, with escalation, repeat reminders and per-conversation snooze.
 *
 * It is pure: every side effect goes through the injected `effects` object so
 * the engine can be unit-tested without Genesys Cloud.
 *
 *   effects.toast({ conversationId, level, row })   level: 'warn' | 'critical' | 'resolved'
 *   effects.sound(level)                            level: 'warn' | 'critical'
 *   effects.badge(count)                            number of conversations needing attention
 *   effects.flash(active)                           true while anything is at warn/critical level
 *
 * Escalation ladder per conversation (wait = seconds since `waitingSince`):
 *
 *   ok        wait <  warnAfterSec
 *   warn      wait >= warnAfterSec            -> one toast + sound
 *   critical  wait >= criticalAfterSec        -> sticky toast + sound, repeated every repeatEverySec
 *   snoozed   agent pressed snooze            -> silent until snooze ends or the customer writes again
 *   resolved  agent replied / interaction ended after an alert -> short "resolved" toast
 */

export const LEVEL_ORDER = { ok: 0, snoozed: 0, warn: 1, critical: 2 };

export class AlertEngine {
  /**
   * @param {object} opts
   * @param {object} opts.settings  See src/config.js for the shape and defaults.
   * @param {object} opts.effects   Side-effect callbacks (all optional).
   */
  constructor({ settings, effects = {} }) {
    this.settings = settings;
    this.effects = effects;
    /** @type {Map<string, {level:string, lastAlertAt:number|null, snoozedUntil:number|null, snoozedWaitingSince:number|null, alertedWaitingSince:number|null}>} */
    this.state = new Map();
    this.lastBadge = null;
    this.lastFlash = null;
  }

  updateSettings(settings) {
    this.settings = settings;
  }

  snooze(conversationId, now = Date.now()) {
    const s = this._stateFor(conversationId);
    s.snoozedUntil = now + Math.max(0, Number(this.settings.snoozeSec) || 0) * 1000;
    s.snoozedWaitingSince = s.currentWaitingSince ?? null;
  }

  unsnooze(conversationId) {
    const s = this._stateFor(conversationId);
    s.snoozedUntil = null;
    s.snoozedWaitingSince = null;
  }

  isSnoozed(conversationId, now = Date.now()) {
    const s = this.state.get(conversationId);
    return !!(s && s.snoozedUntil && s.snoozedUntil > now);
  }

  _stateFor(id) {
    let s = this.state.get(id);
    if (!s) {
      s = { level: 'ok', lastAlertAt: null, snoozedUntil: null, snoozedWaitingSince: null, alertedWaitingSince: null, currentWaitingSince: null };
      this.state.set(id, s);
    }
    return s;
  }

  _levelFor(waitSec) {
    const { warnAfterSec, criticalAfterSec } = this.settings;
    if (criticalAfterSec > 0 && waitSec >= criticalAfterSec) return 'critical';
    if (warnAfterSec > 0 && waitSec >= warnAfterSec) return 'warn';
    return 'ok';
  }

  /**
   * Evaluates a tracker snapshot. Fires effects for transitions and returns the
   * rows decorated with `level`, `waitSec`, `snoozedUntil` for the UI.
   * @param {Array<object>} rows  Output of ConversationTracker.snapshot(now)
   * @param {number} now
   */
  evaluate(rows, now = Date.now()) {
    const seen = new Set();
    const out = [];
    let attention = 0;

    for (const row of rows) {
      seen.add(row.conversationId);
      const s = this._stateFor(row.conversationId);
      s.currentWaitingSince = row.waitingSince;

      let level = 'ok';
      let waitSec = 0;

      if (row.awaiting) {
        waitSec = Math.floor(row.waitMs / 1000);
        level = this._levelFor(waitSec);

        // A snooze only covers the message(s) the agent snoozed. A new inbound
        // message moves `waitingSince`, which cancels the snooze automatically.
        if (s.snoozedUntil && s.snoozedUntil > now && s.snoozedWaitingSince === row.waitingSince) {
          level = level === 'ok' ? 'ok' : 'snoozed';
        } else if (s.snoozedUntil) {
          s.snoozedUntil = null;
          s.snoozedWaitingSince = null;
        }
      }

      this._transition(s, row, level, now);
      if (level === 'warn' || level === 'critical') attention += 1;

      out.push({ ...row, level, waitSec, snoozedUntil: s.snoozedUntil });
    }

    // Conversations that disappeared from the snapshot (ended / transferred).
    for (const [id, s] of this.state) {
      if (seen.has(id)) continue;
      if (LEVEL_ORDER[s.level] >= 1) this._emitToast(id, 'resolved', null, now);
      this.state.delete(id);
    }

    if (attention !== this.lastBadge) {
      this.lastBadge = attention;
      this.effects.badge?.(attention);
    }
    const flash = attention > 0;
    if (flash !== this.lastFlash) {
      this.lastFlash = flash;
      this.effects.flash?.(flash);
    }

    out.sort((a, b) => (LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level]) || (b.waitSec - a.waitSec));
    return out;
  }

  _transition(s, row, level, now) {
    const prev = s.level;
    const escalated = LEVEL_ORDER[level] > LEVEL_ORDER[prev];
    const repeatMs = Math.max(0, Number(this.settings.repeatEverySec) || 0) * 1000;
    const dueRepeat = level === 'critical' && repeatMs > 0 && s.lastAlertAt != null && now - s.lastAlertAt >= repeatMs;
    // The customer wrote again after an alert: treat it as a fresh escalation so the agent hears about it.
    const newMessageSinceAlert = LEVEL_ORDER[level] >= 1 && s.alertedWaitingSince != null && row.waitingSince !== s.alertedWaitingSince;

    if (escalated || dueRepeat || newMessageSinceAlert) {
      this._emitToast(row.conversationId, level, row, now);
      this.effects.sound?.(level);
      s.lastAlertAt = now;
      s.alertedWaitingSince = row.waitingSince;
    } else if (LEVEL_ORDER[prev] >= 1 && LEVEL_ORDER[level] === 0 && level !== 'snoozed') {
      // Alert cleared because the agent replied (or snoozed from the panel -> no toast for snoozed).
      this._emitToast(row.conversationId, 'resolved', row, now);
      s.lastAlertAt = null;
      s.alertedWaitingSince = null;
    }
    s.level = level;
  }

  _emitToast(conversationId, level, row, now) {
    if (level !== 'resolved' && !this.settings.toasts) return;
    if (level === 'resolved' && !this.settings.resolvedToasts) return;
    this.effects.toast?.({ conversationId, level, row, now });
  }
}
