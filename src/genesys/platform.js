/**
 * Platform API access (REST) via the official JavaScript SDK.
 *
 * Authentication uses the OAuth 2 Implicit Grant (Token Implicit) flow with the
 * agent's own Genesys Cloud session, so the app only ever sees what the agent
 * is allowed to see: their own conversations.
 */
import platformClient from 'purecloud-platform-client-v2';

const QUERY_BACKUP_KEY = 'replyRadar.queryBackup';
const BULK_CHUNK = 50;

/**
 * Genesys Cloud appends the integration query string (gcHostOrigin, gcTargetEnv,
 * clientId ...) to the iframe URL. The OAuth redirect comes back to the bare
 * redirect URI, so we stash the query string before leaving and restore it
 * when we come back, before anything else reads `location.search`.
 */
export function restoreQueryAfterRedirect() {
  try {
    const hasToken = /access_token=/.test(globalThis.location?.hash || '');
    const backup = sessionStorage.getItem(QUERY_BACKUP_KEY);
    if (hasToken && backup && !globalThis.location.search) {
      history.replaceState(null, '', `${location.pathname}${backup}${location.hash}`);
    }
  } catch { /* storage blocked: nothing to restore */ }
}

function backupQuery() {
  try {
    if (globalThis.location?.search) sessionStorage.setItem(QUERY_BACKUP_KEY, globalThis.location.search);
  } catch { /* ignore */ }
}

/**
 * @returns {Promise<{client:any, usersApi:any, conversationsApi:any, notificationsApi:any}>}
 */
export async function initPlatform({ clientId, environment, usePopupAuth = false }) {
  if (!clientId) {
    throw new Error('No OAuth client id. Add ?clientId=<your-oauth-client-id> to the integration URL or set VITE_GC_CLIENT_ID at build time.');
  }
  const client = platformClient.ApiClient.instance;
  client.setEnvironment(environment);
  client.setPersistSettings(true, 'replyRadar');
  if (usePopupAuth) client.setAuthPopupConfiguration({ usePopup: true, autoClosePopup: true });

  const redirectUri = `${location.origin}${location.pathname}`;
  backupQuery();
  await client.loginImplicitGrant(clientId, redirectUri);
  // Remove the token from the address bar once the SDK has stored it.
  if (/access_token=/.test(location.hash)) history.replaceState(null, '', `${location.pathname}${location.search}`);

  return {
    client,
    usersApi: new platformClient.UsersApi(),
    conversationsApi: new platformClient.ConversationsApi(),
    notificationsApi: new platformClient.NotificationsApi()
  };
}

export async function getMe(usersApi) {
  const me = await usersApi.getUsersMe({ expand: ['presence'] });
  return { id: me.id, name: me.name, email: me.email };
}

/** Every conversation the agent is currently a participant of. */
export async function listActiveConversations(conversationsApi) {
  const res = await conversationsApi.getConversations();
  return res?.entities || [];
}

/** One conversation, freshly fetched (used after reconnects or when an event looks incomplete). */
export async function getConversation(conversationsApi, conversationId) {
  return conversationsApi.getConversation(conversationId);
}

/**
 * Authoritative direction/text for message ids, via the bulk lookup endpoint.
 * @returns {Promise<Array<{id:string, direction:string, timestamp:string, text:string|null, type:string|null}>>}
 */
export async function fetchMessageDetails(conversationsApi, conversationId, messageIds) {
  const ids = [...new Set(messageIds)].filter(Boolean);
  const out = [];
  for (let i = 0; i < ids.length; i += BULK_CHUNK) {
    const chunk = ids.slice(i, i + BULK_CHUNK);
    const res = await conversationsApi.postConversationsMessageMessagesBulk(conversationId, { body: chunk });
    for (const m of res?.entities || []) {
      out.push({
        id: m.id,
        direction: m.direction,
        timestamp: m.timestamp,
        text: m.normalizedMessage?.text ?? m.textBody ?? null,
        type: m.normalizedMessage?.type ?? null
      });
    }
  }
  return out;
}
