# Paseo plugins (local prototypes)

Trusted, unsandboxed plugins for the Paseo daemon. Split-runtime: server part
(`index.ts`) runs in the daemon, client part (`*.client.tsx`) runs in the app.

- `agent-health` — workspace panel: agent list + statuses, zombie-watchdog
  event tail + all-time counts (reads `~/.pi/agent/zombie-watchdog.jsonl`).
- `om-panel` — workspace panel: observational-memory overview across all
  workspaces (sessions, topic counts, size, recency, INDEX.md head).

## Dev loop

edit -> `npx tsc --noEmit` -> `./check-ids.py` -> `paseo plugin reload <id>`
-> `paseo plugin ls --json` + `paseo plugin logs <id>` (daemon side), then
refresh the app (client side).

## SDK 0.7.2 conventions learned

- RPC method names (daemon-side) must match `^[a-z][a-z0-9._-]*$` (no `/`).
- Panel & Command Center ids (CLIENT-side) must match `^[a-z][a-z0-9-]*$`
  (no dots, no underscores!). Daemon-side `plugin ls` stays green even when
  the app rejects an id - always run `./check-ids.py` before reload.
- Install with absolute paths: `paseo plugin install /abs/path`.
- Global switch: top-level `"pluginsEnabled": true` in `~/.paseo/config.json`.
- Theme colors actually exposed: surface0/1/2, border, foreground,
  foregroundMuted, accent, accentForeground, statusWarning, statusSuccess,
  statusDanger.
- Agent stop/cancel is NOT in the 0.7.2 client SDK; panels display state only.
- `npm install --include=dev` (user npm config sets `omit=dev`).
