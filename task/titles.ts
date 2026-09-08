// Shared session-title cache (duplicated in om-status + om-panel — plugins are
// self-contained by design). Live titles come from Paseo agents.list(); this
// cache preserves titles for sessions whose agent process is gone, so chips
// keep showing names instead of raw UUIDs.
import fs from "node:fs";
import path from "node:path";

export type TitleCache = Record<string, { title: string; agentId?: string | null; ts: number }>;

// Lazy: node:os default import breaks the Metro client bundle (no homedir shim)
// and this module is evaluated on the client even though the cache is only
// touched by server-side RPC handlers.
function cacheFile(): string {
	const home = process.env.PI_HOME ?? process.env.HOME ?? "/home/coder";
	return path.join(home, ".paseo", "plugin-data", "session-titles.json");
}

export function readTitleCache(): TitleCache {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), "utf8")) as TitleCache;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function writeTitleCache(cache: TitleCache): void {
  try {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
    const tmp = `${cacheFile()}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(cache), "utf8");
    fs.renameSync(tmp, cacheFile());
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
