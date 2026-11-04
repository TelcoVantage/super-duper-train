# Genesys Cloud setup guide (admin)

Everything below is done once by a Genesys Cloud administrator. Budget about 20 minutes.

## 1. Host the app over HTTPS

Reply Radar is a static site (`npm run build` → `dist/`). Any HTTPS static host works: GitHub Pages, S3 + CloudFront, Azure Static Web Apps, Netlify, an IIS/nginx folder…

**GitHub Pages (included):**

1. In the GitHub repository go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
2. Push to the default branch (or run the *Deploy to GitHub Pages* workflow manually). The workflow in `.github/workflows/deploy-pages.yml` builds and publishes `dist/`.
3. Note the URL, e.g. `https://<org>.github.io/<repo>/`. **Keep the trailing slash.**

Requirements for any host:

- HTTPS only (Genesys Cloud refuses `http://` client apps).
- The host must **not** send `X-Frame-Options` or a `Content-Security-Policy: frame-ancestors` header that blocks `https://apps.<region>` – the app runs inside a Genesys Cloud iframe.

## 2. Create the OAuth client

**Admin → Integrations → OAuth → + Add Client**

| Field | Value |
|---|---|
| App Name | `Reply Radar` |
| Description | Agent alerts for unanswered chats/messages |
| Token Duration | `86400` (1 day) or your policy |
| Grant Types | **Token Implicit Grant (Browser)** |
| Authorized redirect URIs | the exact hosted URL **without** query string, e.g. `https://<org>.github.io/<repo>/` – add `http://localhost:5173/` too if you want to run `npm run dev` against your org |
| Scope | `conversations`, `notifications`, `users:readonly` |

Save and copy the **Client ID** (there is no secret for an implicit client).

> The app logs in with the *agent's* own Genesys Cloud session. It never sees more than that agent can already see.

## 3. Create the Client Application integration

**Admin → Integrations → Integrations → + Integrations → Client Application → Install**

**Details tab**

- Name: `Reply Radar`
- Notes: anything

**Configuration → Properties**

| Property | Value |
|---|---|
| Application URL | `https://<host>/<path>/?gcHostOrigin={{gcHostOrigin}}&gcTargetEnv={{gcTargetEnv}}&langTag={{gcLangTag}}&gcUsePopupAuth={{gcUsePopupAuth}}&clientId=<OAUTH CLIENT ID>` |
| Application Type | `standalone` |
| Application Category | leave empty (shows under *Apps* in the sidebar) |
| Iframe Sandbox Options | `allow-scripts,allow-same-origin,allow-forms,allow-modals,allow-popups,allow-popups-to-escape-sandbox` |
| Iframe Feature/Permissions Policy | `autoplay` (add to any defaults shown) |
| Group Filtering | the agent groups that should get the app |

Optional threshold defaults for the whole team can be appended to the URL, e.g. `&warn=30&critical=60&repeat=45`. See the README for the full list.

**Configuration → Advanced** (optional, JSON): give the app its own sidebar icon.

```json
{
  "icon": {
    "vector": "https://<host>/<path>/icon.svg"
  }
}
```

Save, then set the integration **Status** to **Active**.

## 4. Permissions check

Agents already have what they need in the out-of-the-box *Communicate* / *Employee* / agent roles. If you use custom roles, confirm they include:

- `conversation:communication:view` – list their own active conversations and read their messages

No supervisor or admin permission is required; the app only ever subscribes to `v2.users.<their own id>.conversations`.

## 5. Agent instructions (copy/paste)

> 1. After you log in, click **Apps → Reply Radar** in the left sidebar once. You can go back to your interactions – it keeps running.
> 2. Click anywhere inside the panel once so your browser allows sound.
> 3. Press **Settings → Test alert** the first time to see what an alert looks like.
> 4. When a customer has waited too long you will get a pop-up, the Reply Radar icon shows a red number, and you hear a beep. Open the panel and press **Open interaction** to jump to the chat.
> 5. If you need a minute, press **Snooze** – the alert comes back if the customer writes again.

## 6. Verify

1. Log in as an agent, go on queue for a messaging queue, open **Reply Radar**. Status pill should read **Live** and the footer shows your name.
2. Send a test message from a web messenger / SMS test number. The interaction appears in the panel with a running timer the moment it connects.
3. Do not reply. After `warn` seconds (45 by default) a toast and a beep appear; the sidebar icon gets a badge. After `critical` seconds the toast turns red and sticky.
4. Reply. The row turns green, a *"Reply sent ✓"* toast replaces the red one, the badge disappears.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Panel shows **"No OAuth client id"** | `clientId=` is missing from the Application URL. |
| Login loop or Genesys error page in the panel | Redirect URI mismatch. The URI in the OAuth client must match the hosted URL exactly (scheme, host, path, trailing slash). |
| Blank white panel | The host sends `X-Frame-Options` / `frame-ancestors` and the browser refuses to frame it, or the Iframe Sandbox Options are missing `allow-scripts,allow-same-origin`. Check the browser console. |
| Login works locally but not for SSO users | The identity provider refuses to load inside an iframe. Keep `gcUsePopupAuth={{gcUsePopupAuth}}` in the URL and `allow-popups` in the sandbox options; Genesys then tells the app to log in through a popup. |
| Status pill stuck on **Reconnecting…** | Corporate proxy/firewall blocking `wss://streaming.<region>`. The app keeps working from the 60-second REST re-sync, but alerts are delayed. |
| **"Session expired – reopen the app"** | The implicit token outlived the OAuth client's token duration. Reopen the app (or raise *Token Duration*). |
| No sound | The agent has not clicked inside the panel since login, or the device is muted. Toasts/badge are unaffected. |
| Alerts for a channel never appear | Only *message* media (Web Messaging, SMS, WhatsApp…) carry message timestamps. Legacy ACD web chat does not and is end-of-life. |
| Agent sees alerts for an interaction they already replied to | Direction confirmation failed (check the console with `&debug=1`). The OAuth client needs the `conversations` scope (not only `conversations:readonly`) because the bulk message lookup is a POST. |

## Running against your org from a laptop

```bash
npm install
npm run dev
```

Add `http://localhost:5173/` to the OAuth client's redirect URIs and open
`http://localhost:5173/?pcEnvironment=<your region domain, e.g. mypurecloud.ie>&clientId=<id>`.
Outside the Genesys iframe, toasts, badge and "open interaction" are written to the browser console instead.
