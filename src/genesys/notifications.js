/**
 * Genesys Cloud Notifications (WebSocket) channel with the plumbing a
 * long-running agent app needs:
 *
 *   - creates a channel and subscribes to topics
 *   - heartbeat watchdog (Genesys sends `channel.metadata` heartbeats; we also ping)
 *   - exponential back-off reconnect; recreates the channel when it expired
 *   - `onReconnect` hook so the caller can re-sync state it may have missed
 */
const PING_EVERY_MS = 30_000;
const WATCHDOG_MS = 95_000;
const MAX_BACKOFF_MS = 30_000;

export class NotificationChannel {
  /**
   * @param {object} opts
   * @param {any} opts.notificationsApi    platformClient.NotificationsApi instance
   * @param {string[]} opts.topics         e.g. ['v2.users.<id>.conversations']
   * @param {(topic:string, body:any, raw:any)=>void} opts.onEvent
   * @param {(status:'connecting'|'connected'|'reconnecting'|'stopped', detail?:string)=>void} [opts.onStatus]
   * @param {()=>void} [opts.onReconnect]  Called after a successful reconnect (not the first connect)
   * @param {(...a:any[])=>void} [opts.log]
   */
  constructor({ notificationsApi, topics, onEvent, onStatus, onReconnect, log = () => {} }) {
    this.api = notificationsApi;
    this.topics = topics;
    this.onEvent = onEvent;
    this.onStatus = onStatus || (() => {});
    this.onReconnect = onReconnect || (() => {});
    this.log = log;
    this.ws = null;
    this.channel = null;
    this.attempt = 0;
    this.stopped = false;
    this.hasConnectedOnce = false;
    this.pingTimer = null;
    this.watchdogTimer = null;
    this.reconnectTimer = null;
  }

  async start() {
    this.stopped = false;
    await this._connect();
  }

  stop() {
    this.stopped = true;
    this._clearTimers();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.onStatus('stopped');
  }

  async _ensureChannel(forceNew = false) {
    if (this.channel && !forceNew) return this.channel;
    this.channel = await this.api.postNotificationsChannels();
    await this.api.putNotificationsChannelSubscriptions(this.channel.id, this.topics.map((id) => ({ id })));
    this.log('channel created', this.channel.id, 'topics', this.topics);
    return this.channel;
  }

  async _connect() {
    if (this.stopped) return;
    this.onStatus(this.hasConnectedOnce ? 'reconnecting' : 'connecting');
    try {
      // After a couple of failed attempts assume the channel expired (24h max) and make a new one.
      const channel = await this._ensureChannel(this.attempt >= 2);
      await this._open(channel.connectUri);
    } catch (err) {
      this.log('connect failed', err);
      this._scheduleReconnect(String(err?.message || err));
    }
  }

  _open(connectUri) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(connectUri);
      this.ws = ws;

      ws.onopen = () => {
        settled = true;
        const wasReconnect = this.hasConnectedOnce;
        this.hasConnectedOnce = true;
        this.attempt = 0;
        this.onStatus('connected');
        this._armTimers();
        if (wasReconnect) this.onReconnect();
        resolve();
      };

      ws.onmessage = (evt) => {
        this._kickWatchdog();
        let msg;
        try { msg = JSON.parse(evt.data); } catch { return; }
        if (!msg?.topicName) return;
        if (msg.topicName === 'channel.metadata') return; // heartbeat / pong
        if (msg.topicName === 'v2.system.socket_closing') {
          this.log('server is closing the socket, reconnecting proactively');
          this._reconnectNow('socket_closing');
          return;
        }
        try {
          this.onEvent(msg.topicName, msg.eventBody, msg);
        } catch (err) {
          this.log('onEvent handler threw', err);
        }
      };

      ws.onerror = (evt) => {
        this.log('websocket error', evt);
        if (!settled) { settled = true; reject(new Error('WebSocket error')); }
      };

      ws.onclose = (evt) => {
        this.log('websocket closed', evt.code, evt.reason);
        this._clearTimers();
        if (this.ws === ws) this.ws = null;
        if (!settled) { settled = true; reject(new Error(`WebSocket closed (${evt.code})`)); return; }
        if (!this.stopped) this._scheduleReconnect(`closed ${evt.code}`);
      };
    });
  }

  _armTimers() {
    this._clearTimers();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try { this.ws.send(JSON.stringify({ message: 'ping' })); } catch { /* ignore */ }
      }
    }, PING_EVERY_MS);
    this._kickWatchdog();
  }

  _kickWatchdog() {
    clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      this.log('no traffic for', WATCHDOG_MS, 'ms, forcing reconnect');
      this._reconnectNow('watchdog');
    }, WATCHDOG_MS);
  }

  _clearTimers() {
    clearInterval(this.pingTimer);
    clearTimeout(this.watchdogTimer);
    clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.watchdogTimer = null;
    this.reconnectTimer = null;
  }

  _reconnectNow(reason) {
    const ws = this.ws;
    this.ws = null;
    this._clearTimers();
    if (ws) { try { ws.close(); } catch { /* ignore */ } }
    this._scheduleReconnect(reason, 0);
  }

  _scheduleReconnect(reason, delayOverride) {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    const delay = delayOverride ?? Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.attempt, 5)) + Math.random() * 500;
    this.attempt += 1;
    this.onStatus('reconnecting', reason);
    this.log(`reconnecting in ${Math.round(delay)}ms (${reason}), attempt ${this.attempt}`);
    this.reconnectTimer = setTimeout(() => this._connect(), delay);
  }
}

/** Topic that carries every conversation change for one user, across all media types. */
export function userConversationsTopic(userId) {
  return `v2.users.${userId}.conversations`;
}
