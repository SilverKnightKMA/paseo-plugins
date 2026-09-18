# Paseo plugins (local prototypes)

> **⚠️ Fresh install / hệ 2 repo:** repo này đơn lẻ KHÔNG chạy được — plugin render dữ liệu do extension bên [`pi-config`](https://github.com/SilverKnightKMA/pi-config) sinh ra. Cài từ đầu trên máy mới (Linux/macOS/Windows native): đọc [`setup/SETUP-PASEO.md`](setup/SETUP-PASEO.md) sau khi đã xong [`setup/SETUP-PI.md`](https://github.com/SilverKnightKMA/pi-config/blob/main/setup/SETUP-PI.md) — thiếu một trong hai là hệ không hoạt động.

Trusted, unsandboxed plugins for the Paseo daemon. Split-runtime: server part
(`index.ts`) runs in the daemon, client part (`*.client.tsx`) runs in the app.

- `agent-health` — workspace panel: agent list + statuses, zombie-watchdog
  event tail + all-time counts (reads `~/.pi/agent/zombie-watchdog.jsonl`).
- `om-panel` — workspace panel: observational-memory overview across all
  workspaces (sessions, topic counts, size, recency, INDEX.md head).
- `lessons` — workspace panel: folded lessons (`~/.pi/agent/lessons.md`)
  grouped by tag with age; timeline transformer collapses the injected
  "Lessons from past sessions" context block into one 📚 chip (#110).

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
