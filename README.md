# Ticketing client

A system-tray **ticketing** app — the companion to the [status monitor](https://github.com/redstonejh/report-monitor-tray-dashboard). It is the monitor's Electron shell with the MQTT **monitoring** layer removed, leaving a thin tickets backend.

## How the two apps form one ecosystem

| Shared thing | Mechanism |
|---|---|
| **Accounts / sign-in (SSO)** | Both apps read/write the same `~/.status-monitor/users.json` + `session.json`. `electron/auth.js` is byte-identical to the monitor's. Sign into one → signed into the other. |
| **Tickets** | One retained MQTT topic tree, **`tickets/<id>`**, on the same broker (`24.121.212.206:1883`). Each ticket is a retained JSON doc; an empty retained payload is a tombstone (delete). |

### The failure → ticket flow

1. The **monitor** detects a sustained outage (4+ consecutive down-minutes — the "red rising edge") and **publishes one retained ticket** to `tickets/<id>` (`maybeCreateTicket` in its `main.js`). The id is derived deterministically from the outage episode, so multiple monitors collapse to one ticket. On recovery it sets `recoveredAt` **without** closing the ticket.
2. This **ticketing app** subscribes to `tickets/#`, caches the retained docs, and lets humans **claim / assign / resolve** — each a read-modify-write that republishes the retained doc.

Because the messages are retained, the broker is the source of truth: a fresh launch replays every open ticket on subscribe. No local database.

### Ticket schema (identical on both sides)

```jsonc
{
  "id": "…", "episodeKey": "…|null",
  "companyId": "…", "companyLabel": "…", "host": "…",
  "severity": "red", "state": "open|claimed|assigned|resolved",
  "createdAt": "ISO",
  "assignee": null, "assignedBy": null, "claimedBy": null,
  "recoveredAt": null, "resolvedAt": null, "resolvedBy": null,
  "updatedAt": 0, "version": 1,
  "history": [{ "at": "ISO", "by": "user", "action": "created", "detail": "…" }]
}
```

## Backend surface (IPC)

`window.tickets`: `list`, `connectionState`, `onChanged`, `onConnection`, `claim`, `unclaim`, `assign`, `resolve`, `reopen`, `comment`, `create`, `remove`.
`window.auth`: full account API (shared with the monitor).
Writes require a signed-in user; **delegate** (`assign`) and **delete** require an admin.

## Front end = the monitor's shell, vendored

`dashboard/` is the status monitor's dashboard chrome **vendored verbatim** — the same design system (`tokens/base/components/dashboard-grid/themes/utilities.css`), glass, liquid-glass, the canonical menus (background picker, account menu, search), and the auth gate. `DESIGN_SYSTEM.md` travels with the repo. This guarantees **zero visual drift** from the monitor.

What changed for ticketing:
- The MQTT **data** runtime is neutralised: `dashboard-preload.js` exposes a **stubbed `window.dashboard`** (every channel returns empty / never fires), so the shell renders with no monitoring.
- The monitor's default widgets (latency/loss trackers, status-timeline chart, recent-checks table) are removed from `dashboard/index.html`, leaving an **empty canonical glass workspace**.
- The sign-in gate is rebranded **"Ticketing"** (`auth-ui.js`).

The real ticketing UI is **not built yet** — it gets built on this canonical shell, where `window.tickets` is the data source. Until then the workspace is intentionally empty.

> Verify visually over CDP (no HMR): `npm start -- -- --remote-debugging-port=<port>`, then drive the page target with a `ws` CDP script. Sign in with `window.auth.login('admin','admin1')`.

## Run / build

```bash
npm install
npm start          # add: -- -- --remote-debugging-port=9223   to verify over CDP
npm run make       # Squirrel installer (TicketingClient-Setup.exe)
```
