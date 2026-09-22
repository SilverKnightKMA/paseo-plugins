/**
 * Persisted tier-1 reminded set (task #230).
 *
 * The once-per-child promise only holds if the set survives daemon restarts —
 * without persistence the plugin would re-remind every settled child after each
 * reload, which is exactly #141's nag loop reborn. Stored as
 * ~/.paseo/plugin-data/paseo-subagents/reminded.json: { [childId]: remindedAtMs }.
 * Entries older than REMINDED_TTL_MS are pruned on save (they describe children
 * long since archived or deleted).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const REMINDED_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days

export function remindedPath(dataDir: string): string {
  return join(dataDir, "reminded.json");
}

export function loadReminded(path: string): Map<string, number> {
  const out = new Map<string, number>();
  if (!existsSync(path)) return out;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    for (const [id, v] of Object.entries(raw)) {
      if (typeof v === "number" && Number.isFinite(v)) out.set(id, v);
    }
  } catch {
    // Corrupt/partial file — treat as empty; worst case is one extra reminder.
  }
  return out;
}

/** Atomic-ish write (tmp + rename). Returns the pruned map actually persisted. */
export function saveReminded(path: string, entries: Map<string, number>, nowMs = Date.now()): Map<string, number> {
  const pruned = new Map<string, number>();
  for (const [id, at] of entries) {
    if (nowMs - at < REMINDED_TTL_MS) pruned.set(id, at);
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(pruned)));
    renameSync(tmp, path);
  } catch {
    // Disk error — the in-memory set still guards this process; retry on next save.
  }
  return pruned;
}
