/**
 * pa1 adopt-from-disk (spec v12 section 11) — durable door tokens after restart.
 *
 * Context: TokenRegistry is in RAM; restarting the plugin permanently breaks every
 * door because a verification miss only returns 401. However, MINTED tokens remain
 * in the on-disk agent record (`config.mcpServers[...].url?caller=<token>`, written
 * at creation). When a request with an unknown token reaches the door (verification
 * miss), adoptFromRecord finds that token in a record, registers the SAME token
 * string in RAM again, and binds it.
 *
 * Invariants (v12):
 * - READ-ONLY records (daemon-owned — do not write or change URLs).
 * - Do NOT mint a new token or scan in the background — run only when a request arrives (event-driven).
 * - Token not found in any record → null → caller gets 401 as before (fail-honest).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TokenRegistry } from "./tokens.js";

export const MAIN_DOOR_KEY = "paseo-subagents";
export const CHILD_DOOR_KEY = "paseo";

export interface AdoptHit {
  agentId: string;
  title: string;
  url: string;
  isChild: boolean;
  depth: number;
  role?: string;
}

interface RawRecord {
  id?: string;
  title?: string;
  labels?: Record<string, string>;
  archivedAt?: string | null;
  config?: { mcpServers?: Record<string, { url?: string }> };
}

/** Read a record file and extract its door URL (main key first, then child key) and metadata. */
function readRecord(file: string): { id: string; title: string; url: string; isChild: boolean; depth: number; role?: string; archived: boolean } | null {
  let raw: RawRecord;
  try {
    raw = JSON.parse(readFileSync(file, "utf-8")) as RawRecord;
  } catch {
    return null; // Incomplete or invalid JSON — skip it and retry on the next miss.
  }
  const id = raw.id ?? "";
  if (!id) return null;
  const mainUrl = raw.config?.mcpServers?.[MAIN_DOOR_KEY]?.url;
  const childUrl = raw.config?.mcpServers?.[CHILD_DOOR_KEY]?.url;
  const url = mainUrl ?? childUrl;
  if (!url) return null; // Record has no door, so it is not a candidate.
  const labels = raw.labels ?? {};
  const isChild = typeof labels["subagent.parent"] === "string" && labels["subagent.parent"] !== "";
  const depthRaw = Number(labels["subagent.depth"]);
  return {
    id,
    title: raw.title ?? "untitled",
    url,
    isChild,
    depth: Number.isFinite(depthRaw) && depthRaw > 0 ? depthRaw : 1,
    role: labels["subagent.role"],
    archived: typeof raw.archivedAt === "string" && raw.archivedAt !== "",
  };
}

/**
 * Scan agentsRoot READ-ONLY for a record whose door URL contains the exact token.
 * Return the first non-archived record in alphabetical ID order. If the token only
 * appears in archived records, still return one (the door token may still be valid)
 * with hit.archived. The token must match EXACTLY (all 48 hex characters in the
 * caller parameter).
 */
export function findRecordByToken(agentsRoot: string, token: string): (AdoptHit & { archived: boolean }) | null {
  if (!/^[0-9a-f]{48}$/.test(token)) return null;
  if (!existsSync(agentsRoot)) return null;
  const want = `caller=${token}`;
  const candidates: Array<{ file: string; hit: AdoptHit & { archived: boolean } }> = [];
  for (const ws of readdirSync(agentsRoot, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    for (const f of readdirSync(join(agentsRoot, ws.name), { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith(".json")) continue;
      const file = join(agentsRoot, ws.name, f.name);
      const rec = readRecord(file);
      if (!rec) continue;
      const u = rec.url;
      if (!u.includes(want)) continue;
      // The caller parameter must be EXACTLY the token (prevent false prefix matches).
      const param = u.slice(u.indexOf("caller=") + 7).split("&")[0];
      if (param !== token) continue;
      candidates.push({ file, hit: { agentId: rec.id, title: rec.title, url: rec.url, isChild: rec.isChild, depth: rec.depth, role: rec.role, archived: rec.archived } });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  if (candidates.length > 1) {
    console.warn(`[paseo-subagents] adopt: ${candidates.length} records share a token (unexpected) — using the first alphabetically: ${candidates[0].file}`);
  }
  const pick = candidates.find((c) => !c.hit.archived) ?? candidates[0];
  return pick.hit;
}

/**
 * Infer capabilities from the record: child (subagent.parent label) → canSpawn=false,
 * depth from the label; main → canSpawn=true, depth 0. Call registry.adopt with the
 * SAME token string. Return the restored RAM entry, or null (not found → caller gets
 * 401 as before).
 */
export function adoptFromRecord(agentsRoot: string, token: string, registry: TokenRegistry): { agentId: string; isChild: boolean } | null {
  const hit = findRecordByToken(agentsRoot, token);
  if (!hit) return null;
  try {
    registry.adopt(token, {
      parentId: hit.isChild ? "adopted-from-record" : hit.agentId,
      title: hit.title,
      depth: hit.isChild ? hit.depth : 0,
      canSpawn: !hit.isChild,
      role: hit.role,
      boundAgentId: hit.agentId,
    });
  } catch (err) {
    console.error(`[paseo-subagents] failed to adopt token ${token.slice(0, 8)}…: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  console.log(`[paseo-subagents] adopt token ${token.slice(0, 8)}… <- record ${hit.agentId} (${hit.isChild ? `child depth ${hit.depth}` : "main"})`);
  return { agentId: hit.agentId, isChild: hit.isChild };
}
