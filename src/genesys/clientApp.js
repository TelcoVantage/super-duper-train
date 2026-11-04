/**
 * Thin wrapper around the Genesys Cloud Client App SDK.
 *
 * The SDK talks to the Genesys Cloud host page (the agent UI that embeds this
 * app in an iframe) over postMessage. It is what lets us:
 *   - show toast pop-ups in the agent UI          (alerting.showToastPopup)
 *   - put a counter badge on our sidebar icon     (alerting.setAttentionCount)
 *   - jump the agent straight to an interaction   (myConversations.showInteractionDetails)
 *   - react to the host's lifecycle (bootstrap / focus / blur / stop)
 */
import ClientApp from 'purecloud-client-app-sdk';

const TOAST_PREFIX = 'rr-';

export function createClientApp({ defaultEnvironment = 'mypurecloud.com', search = globalThis.location?.search || '' } = {}) {
  const q = new URLSearchParams(search);
  let cfg;
  if (q.has('gcHostOrigin') && q.has('gcTargetEnv')) {
    // Modern interpolation: {{gcHostOrigin}} / {{gcTargetEnv}}
    cfg = { gcHostOriginQueryParam: 'gcHostOrigin', gcTargetEnvQueryParam: 'gcTargetEnv' };
  } else if (q.has('pcEnvironment')) {
    // Legacy interpolation: {{pcEnvironment}}
    cfg = { pcEnvironmentQueryParam: 'pcEnvironment' };
  } else {
    cfg = { pcEnvironment: defaultEnvironment };
  }

  const app = new ClientApp(cfg);
  const environment = app.gcEnvironment || defaultEnvironment;
  const embedded = globalThis.parent && globalThis.parent !== globalThis;

  return {
    app,
    environment,
    embedded,
    version: ClientApp.version,

    /**
     * Shows a toast in the Genesys Cloud UI. Critical toasts are "error" type,
     * which the SDK requires to be sticky (timeout 0 + close button).
     */
    toast({ id, title, message, level = 'info', timeoutSec = 8 }) {
      const toastId = TOAST_PREFIX + (id || 'general');
      if (!embedded) { console.info('[ReplyRadar toast]', level, title, '\n' + message); return; }
      if (level === 'critical') {
        app.alerting.showToastPopup(title, message, { id: toastId, type: 'error', timeout: 0, showCloseButton: true, markdownMessage: true });
      } else {
        const type = level === 'resolved' ? 'success' : 'info';
        app.alerting.showToastPopup(title, message, { id: toastId, type, timeout: timeoutSec, showCloseButton: true, markdownMessage: true });
      }
    },

    badge(count) {
      if (!embedded) { console.info('[ReplyRadar badge]', count); return; }
      app.alerting.setAttentionCount(Math.max(0, Math.floor(count)));
    },

    jumpTo(conversationId) {
      if (!embedded) { console.info('[ReplyRadar jump]', conversationId); return; }
      app.myConversations.showInteractionDetails(conversationId);
    },

    onBootstrap(fn) { app.lifecycle.addBootstrapListener(fn); },
    onFocus(fn) { app.lifecycle.addFocusListener(fn); },
    onBlur(fn) { app.lifecycle.addBlurListener(fn); },
    onStop(fn) { app.lifecycle.addStopListener(fn); },
    bootstrapped() { app.lifecycle.bootstrapped(); },
    stopped() { app.lifecycle.stopped(); }
  };
}
