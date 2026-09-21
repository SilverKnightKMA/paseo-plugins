/**
 * L1 door grant (spec v12 section 11) — a main created BEFORE the plugin has no door.
 *
 * The door is injected only in before(agent.create); an older main (such as a
 * session created on 05/09) has an empty mcpServers record and can never spawn.
 * L1: when that main ends a turn (agent.turn_ended), the plugin mints and binds a
 * NEW token, then sends `[door-grant] <url>` to the chat through
 * api.agents.ref(id).send(). The main uses the URL via HTTP POST tools/call;
 * children spawned through this door report [child-report] to the correct main.
 *
 * Guard: exactly once per process per agent (GrantLedger); skip archived agents
 * and children (subagent.parent label); grant only when the record has NO door
 * (never overwrite another door). Self-heals after restart (new process → empty
 * ledger → grant again on the next turn).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SubagentReplyRuntime } from "./hooks.js";
import { MAIN_DOOR_KEY, CHILD_DOOR_KEY } from "./adopt.js";

export const DOOR_GRANT_PREFIX = "[door-grant]";

export interface MainDoorState {
  /** Whether this agent's record file was found. */
  found: boolean;
  isChild: boolean;
  archived: boolean;
  /** Whether the record already has a door URL under the main or child key. */
  hasDoor: boolean;
}

/** Read a record without modifying it and return the agent's door state (used by shouldGrant). */
export function readMainDoorState(agentsRoot: string, agentId: string): MainDoorState {
  const empty: MainDoorState = { found: false, isChild: false, archived: false, hasDoor: false };
  if (!existsSync(agentsRoot)) return empty;
  for (const ws of readdirSync(agentsRoot, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const file = join(agentsRoot, ws.name, `${agentId}.json`);
    if (!existsSync(file)) continue;
    try {
      const raw = JSON.parse(readFileSync(file, "utf-8")) as {
        labels?: Record<string, string>;
        archivedAt?: string | null;
        config?: { mcpServers?: Record<string, { url?: string }> };
      };
      const labels = raw.labels ?? {};
      const mainUrl = raw.config?.mcpServers?.[MAIN_DOOR_KEY]?.url;
      const childUrl = raw.config?.mcpServers?.[CHILD_DOOR_KEY]?.url;
      return {
        found: true,
        isChild: typeof labels["subagent.parent"] === "string" && labels["subagent.parent"] !== "",
        archived: typeof raw.archivedAt === "string" && raw.archivedAt !== "",
        hasDoor: Boolean(mainUrl ?? childUrl),
      };
    } catch {
      return empty; // Invalid JSON: treat as not found and read it again next turn.
    }
  }
  return empty;
}

/**
 * Pure, testable grant decision: grant if and only if the record exists, belongs
 * to a main, is not archived, and has NO door. (RAM and ledger checks happen in
 * the wiring — step #156.)
 */
export function shouldGrant(state: MainDoorState): boolean {
  return state.found && !state.isChild && !state.archived && !state.hasDoor;
}

/** Exactly one grant per process per agent — resets when the plugin restarts.
 *  Store the token so L1 (turn_ended message) and L2 (session_open env) SHARE
 *  one token for the same agent instead of minting twice. */
export class GrantLedger {
  private readonly byAgent = new Map<string, string>();

  /** true if this agent has NOT been granted in the current process. */
  allow(agentId: string): boolean {
    return !this.byAgent.has(agentId);
  }

  mark(agentId: string, token: string): void {
    this.byAgent.set(agentId, token);
  }

  /** Token granted in this process (reused by L2), or null. */
  tokenFor(agentId: string): string | null {
    return this.byAgent.get(agentId) ?? null;
  }

  get size(): number {
    return this.byAgent.size;
  }
}

/**
 * L2 env door (spec v12 section 11): compute the door URL to place in the
 * PASEO_SUBAGENTS_DOOR environment variable for a main without a door. Reuse the
 * L1 token if this process already granted one; otherwise mint a new token. Return
 * null when ineligible (child/archived/already has a door/no record) or when the
 * door is not listening. Do NOT write the record.
 */
export function envDoorUrlForMain(agentsRoot: string, rt: SubagentReplyRuntime, ledger: GrantLedger, agentId: string, title: string): string | null {
  const state = readMainDoorState(agentsRoot, agentId);
  if (!shouldGrant(state)) return null;
  const existing = ledger.tokenFor(agentId);
  if (existing) {
    const port = rt.getPort();
    if (port === null) return null;
    return `http://127.0.0.1:${port}/mcp?caller=${existing}`;
  }
  const url = mintDoorForMain(rt, agentId, title);
  if (!url) return null;
  const token = new URL(url).searchParams.get("caller");
  if (!token) return null;
  ledger.mark(agentId, token);
  return url;
}

/**
 * Mint a NEW token for an older main and bind it immediately (agentId is already
 * known, unlike creation-time minting with parentId='(main)'). Return the complete
 * door URL to send to the chat.
 */
export function mintDoorForMain(rt: SubagentReplyRuntime, agentId: string, title: string): string | null {
  const port = rt.getPort();
  if (port === null) return null; // Door is not listening: skip now and retry next turn.
  const token = rt.registry.mint(agentId, title, { depth: 0, canSpawn: true });
  rt.registry.bind(token, agentId);
  const url = `http://127.0.0.1:${port}/mcp?caller=${token}`;
  rt.log(`[paseo-subagents] door-grant mint: agent ${agentId} ('${title}') — token ${token.slice(0, 8)}…`);
  return url;
}

/** Format the grant message (constant prefix makes it easy for the main/E2E tests to grep). */
export function doorGrantMessage(url: string): string {
  return `${DOOR_GRANT_PREFIX} ${url}`;
}
