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

/**
 * #223 Option 1 (v1.0.92): the plugin NO LONGER sends this message to the chat.
 * The L1 mint still happens (silently) — discovery is the engine's job via
 * door-state.json self-heal (pi-config v1.4.131) + env-door L2 + the fixed
 * port range. The helpers stay exported for tests and for any future hatch
 * that needs to render the URL a main would have received.
 */
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

/** Cross-process grant persistence (F10 #219): a GrantStore-backed object so
 *  grant.ts stays free of fs imports and unit-testable. */
export interface GrantPersistence {
	/** Token granted by a PREVIOUS plugin process, or null. */
	restore(agentId: string): { token: string; title: string } | null;
	/** Remember a freshly minted token for future processes. */
persist(agentId: string, token: string, title: string): void;
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
export function envDoorUrlForMain(
	agentsRoot: string,
	rt: SubagentReplyRuntime,
	ledger: GrantLedger,
	agentId: string,
	title: string,
	store: GrantPersistence | null = null,
): string | null {
	const state = readMainDoorState(agentsRoot, agentId);
	if (!shouldGrant(state)) return null;
	return doorUrlForMain(rt, ledger, store, agentId, title)?.url ?? null;
}

/** Reuse-or-mint one door grant for a doorless main (F10 #219). Resolution
 *  order: (1) token granted in THIS process (RAM ledger — L1/L2 share it),
 *  (2) token persisted by a PREVIOUS process (adopted back into the registry,
 *  never re-minted — a rotating port must not rotate identities), (3) fresh
 *  mint, persisted via the store. Returns null when the door is not listening. */
export function doorUrlForMain(
	rt: SubagentReplyRuntime,
	ledger: GrantLedger,
	store: GrantPersistence | null,
	agentId: string,
	title: string,
): { url: string; token: string; freshMint: boolean } | null {
	const port = rt.getPort();
	if (port === null) return null;
	const ram = ledger.tokenFor(agentId);
	if (ram) return { url: `http://127.0.0.1:${port}/mcp?caller=${ram}`, token: ram, freshMint: false };
	const saved = store?.restore(agentId) ?? null;
	if (saved && /^[0-9a-f]{48}$/.test(saved.token)) {
		rt.registry.adopt(saved.token, { parentId: agentId, title: saved.title, depth: 0, canSpawn: true, boundAgentId: agentId });
		ledger.mark(agentId, saved.token);
		return { url: `http://127.0.0.1:${port}/mcp?caller=${saved.token}`, token: saved.token, freshMint: false };
	}
	const url = mintDoorForMain(rt, agentId, title);
	if (!url) return null;
	const token = new URL(url).searchParams.get("caller");
	if (!token) return null;
	ledger.mark(agentId, token);
	store?.persist(agentId, token, title);
	return { url, token, freshMint: true };
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

/** Format the grant message. F10 (#219, user objection 2026-09-22): a bare URL
 *  injected as a user message is rejected — the message must describe itself.
 *  The constant prefix stays on line 1 for the main/E2E greps. */
export function doorGrantMessage(url: string): string {
	return [
		`${DOOR_GRANT_PREFIX} ${url}`,
		"paseo-subagents door URL for this session — the door port rotated (plugin restarted).",
		"- Engine v1.4.131+: door tools re-discover the port automatically — no action needed.",
		"- Older engine code: POST MCP JSON-RPC tools/call to the URL above (spawn_subagent, spawn_pool, answer_child).",
	].join("\n");
}
