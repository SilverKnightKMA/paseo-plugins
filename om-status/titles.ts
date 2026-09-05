// Shared session-title cache (duplicated in om-status + om-panel — plugins are
// self-contained by design). Live titles come from Paseo agents.list(); this
// cache preserves titles for sessions whose agent process is gone, so chips
// keep showing names instead of raw UUIDs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type TitleCache = Record<string, { title: string; agentId?: string | null; ts: number }>;

const CACHE_FILE = path.join(os.homedir(), ".paseo", "plugin-data", "session-titles.json");

export function readTitleCache(): TitleCache {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as TitleCache;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function writeTitleCache(cache: TitleCache): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const tmp = `${CACHE_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(cache), "utf8");
    fs.renameSync(tmp, CACHE_FILE);
  } catch {
    // best-effort; cache is an enhancement, never a dependency
  }
}

/** Merge live (sessionId → title) into the cache and persist. */
export function mergeLiveTitles(live: Map<string, string>): TitleCache {
  const cache = readTitleCache();
  const now = Date.now();
  for (const [sid, title] of live) cache[sid] = { title, ts: now };
  if (live.size > 0) writeTitleCache(cache);
  return cache;
}

export function titleFor(cache: TitleCache, sessionId: string, live?: Map<string, string>): string | null {
  return live?.get(sessionId) ?? cache[sessionId]?.title ?? null;
}
