# Ticketing web deployment in Portainer

This branch packages the Electron Ticketing dashboard as a browser application
at `http://192.168.203.118:8082`. Tickets and accounts persist in the
`ticketing-web-data` Docker volume.

The current Ticketing source uses `electron/tickets.js`, a local JSON store. It
does not use MQTT despite older README text describing the previous broker
implementation. The web service preserves that current JSON-backed contract.

## Runtime environment variables

| Name | Source consumer | Purpose |
| --- | --- | --- |
| `TICKETING_WEB_PORT` | `status-monitor-web/server.js` | Container HTTP port (`8080`) |
| `TICKETING_DATA_DIR` | `status-monitor-web/server.js` | Persistent account and ticket files |
| `TICKETING_ADMIN_USERNAME` | `status-monitor-web/server.js` | First-run administrator username |
| `TICKETING_ADMIN_PASSWORD` | `status-monitor-web/server.js` | First-run administrator password |
| `TICKETING_SESSION_TTL_MS` | `status-monitor-web/server.js` | Optional session lifetime |
| `TICKETING_COOKIE_SECURE` | `status-monitor-web/server.js` | Set to `1` only when using HTTPS |

## Build

Create a root-level tar archive from this branch:

```bash
git archive --format=tar --output=ticketing-portainer.tar portainer-web
```

In Portainer, open **local → Images → Build a new image**, enter
`ticketing-web:latest`, choose **Upload**, select the tar archive, use
`Dockerfile`, and build.

## Deploy

Open **local → Stacks → Add stack → Web editor**, name the stack
`ticketing-web`, paste `portainer-stack.yml`, and add:

- `TICKETING_ADMIN_USERNAME=admin`
- `TICKETING_ADMIN_PASSWORD=<a strong initial password>`

Deploy the stack, wait for `ticketing-web` to become healthy, and open
`http://192.168.203.118:8082`.

The administrator variables seed an empty volume only. Changing them later does
not overwrite existing accounts.

