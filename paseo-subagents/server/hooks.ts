/**
 * `before("agent.create")` hook: turns the broad daemon MCP catalog OFF for
 * children spawned with PASEO_PARENT_AGENT_ID, and hands them a scoped
 * one-tool reply door instead.
 *
 * Why this works (verified in daemon source):
 *  - agent-manager applies the before-hook's returned {config, env} before
 *    preparing the stored session config;
 *  - withRuntimePaseoMcpServer skips injecting the full catalog when the
 *    stored config already has an entry named "paseo";
 *  - stripInternalPaseoMcpServer only strips entries whose URL pathname is
 *    /mcp/agents — our door lives at /mcp and survives.
 *
 * The parent id never reaches the child as addressable state: it is consumed
 * here (bound to an opaque token) and stripped from env.
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { TokenRegistry } from "./tokens.js";
import { checkFloor, isNormalizedMode, providerFamily, translateMode } from "./mode-table.js";

/** Structural slice of AgentSessionConfig the rewrite touches (avoids importing
 *  @getpaseo/protocol, which is not a plugin-SDK specifier). The daemon's real
 *  config is a superset — the slice is compatible by structure. */
export interface AgentCreateConfig {
  provider: string;
  title?: string | null;
  modeId?: string;
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export const PARENT_ENV = "PASEO_PARENT_AGENT_ID";
export const MODE_ENV = "PASEO_CHILD_MODE";
/** L2 environment variable (spec v12): door-grant URL for a main without a door (read by pi ext v1.4.108). */
export const DOOR_ENV = "PASEO_SUBAGENTS_DOOR";

export interface SubagentReplyRuntime {
  registry: TokenRegistry;
  /** Current listener port, or null until the socket is bound. */
  getPort: () => number | null;
  allowFull: boolean;
  log: (message: string) => void;
}

export interface AgentCreateInput {
  config: AgentCreateConfig;
  env?: Record<string, string>;
}

export function rewriteChildConfig(input: AgentCreateInput, rt: SubagentReplyRuntime): AgentCreateInput {
  const env = { ...(input.env ?? {}) };
  const parentId = env[PARENT_ENV];
  if (!parentId) return input; // regular agent: untouched

  const requestedRaw = env[MODE_ENV];
  if (requestedRaw !== undefined && !isNormalizedMode(requestedRaw)) {
    throw new Error(
      `[paseo-subagents] invalid ${MODE_ENV} '${requestedRaw}': expected one of read-only|auto|review|full — refusing spawn (fail-closed)`,
    );
  }

  const family = providerFamily(input.config.provider);
  if (requestedRaw !== undefined) {
    const floor = checkFloor(input.config.provider, requestedRaw, rt.allowFull);
    if (!floor.ok) {
      throw new Error(`[paseo-subagents] spawn refused (fail-closed): ${floor.reason}`);
    }
  }

  const port = rt.getPort();
  if (port === null) {
    throw new Error("[paseo-subagents] reply door is not listening yet — retry the spawn in a moment");
  }

  const title = input.config.title ?? "subagent";
  const token = rt.registry.mint(parentId, title, { depth: 1, canSpawn: false });

  const mcpServers = {
    ...(input.config.mcpServers ?? {}),
    paseo: {
      type: "http" as const,
      url: `http://127.0.0.1:${port}/mcp?caller=${token}`,
      alwaysLoad: true,
    },
  } as Record<string, unknown>;
  const config: AgentCreateConfig = { ...input.config, mcpServers };

  if (requestedRaw !== undefined) {
    const decision = translateMode(input.config.provider, requestedRaw);
    if (decision.modeId !== undefined) config.modeId = decision.modeId;
    if (decision.warning) rt.log(`[paseo-subagents] ${family}: ${decision.warning}`);
  }

  delete env[PARENT_ENV];
  delete env[MODE_ENV];

  rt.log(`[paseo-subagents] scoped reply door: child '${title}' (family=${family}) -> parent ${parentId}`);
  return { config, env };
}

/** Dedicated MCP key for main (spec 4.1): main sees the door tool ALONGSIDE the daemon catalog (G2 coexistence). */
export const MAIN_MCP_KEY = "paseo-subagents";

/** Inject a spawn door when creating a MAIN agent (without PASEO_PARENT_AGENT_ID).
 *  Token depth=0 canSpawn=true — main is the orchestrator (spec section 6). */
export function injectMainDoor(input: AgentCreateInput, rt: SubagentReplyRuntime): AgentCreateInput {
  if (PARENT_ENV in (input.env ?? {})) return input; // The child path is handled separately.
  // A plugin-spawned child already carries a scoped door under the 'paseo' config key (spawnFn mints it directly).
  // Do NOT inject a main door (E2E 2026-09-20: giving a child another canSpawn door creates a recursion vulnerability).
  if ((input.config.mcpServers ?? {}) ["paseo"] !== undefined) return input;
  const port = rt.getPort();
  if (port === null) return input; // Door is not listening: create the main normally without blocking.
  const title = input.config.title ?? "main";
  const token = rt.registry.mint("(main)", title, { depth: 0, canSpawn: true });
  const mcpServers = {
    ...(input.config.mcpServers ?? {}),
    [MAIN_MCP_KEY]: {
      type: "http" as const,
      url: `http://127.0.0.1:${port}/mcp?caller=${token}`,
      alwaysLoad: true,
    },
  } as Record<string, unknown>;
  rt.log(`[paseo-subagents] main door injected: '${title}' provider=${input.config.provider} (canSpawn, depth 0)`);
  return { ...input, config: { ...input.config, mcpServers } };
}

export function registerSubagentReplyHook(server: PluginServerContext, rt: SubagentReplyRuntime): () => void {
  return server.before("agent.create", (input) => {
    const request = input.request as unknown as AgentCreateInput;
    // Permanent observability (plan step 1 / G1, 2026-09-20): one line per
    // hook fire so MAIN-agent creates (no parent env) are visible in plugin
    // logs too — not only the child rewrites.
    const isChild = PARENT_ENV in (request.env ?? {});
    rt.log(
      `[paseo-subagents] agent.create hook: title='${request.config.title ?? "(untitled)"}' provider=${request.config.provider} child=${isChild ? "yes" : "no"}`,
    );
    const rewritten = isChild ? rewriteChildConfig(request, rt) : injectMainDoor(request, rt);
    if (rewritten === request) return undefined; // unchanged: regular agent
    return rewritten as unknown as typeof input.request;
  });
}

/** Structural slice of the agent.session_open before-hook request (spike 2026-09-21:
 *  buildLaunchContext agent-manager.js:3628 — request carries agentId/provider/
 *  cwd/workspaceId/reason(create|resume|refresh|import)/purpose/env; the hook may
 *  change only env, and the daemon uses transformed.env for the agent process). */
export interface SessionOpenInput {
  agentId?: string;
  provider?: string;
  title?: string | null;
  reason?: string;
  purpose?: string;
  env?: Record<string, string>;
  [key: string]: unknown;
}

export interface EnvDoorOptions {
  agentsRoot: string;
  /** Determine the URL (read the record without modifying it; mint/reuse the token through the ledger). */
  envDoorUrlFor: (agentId: string, title: string) => string | null;
}

/**
 * L2 env door (spec v12 section 11): before("agent.session_open") — a main
 * without a door (created before the plugin) receives
 * PASEO_SUBAGENTS_DOOR=<url> whenever its process opens
 * (create/resume/refresh/import). Pi ext v1.4.108 reads this environment variable
 * BEFORE the record, so one Refresh gives the main a native proxy door. Do NOT
 * modify child environments.
 */
export function registerEnvDoorHook(server: PluginServerContext, rt: SubagentReplyRuntime, opts: EnvDoorOptions): () => void {
  try {
    return server.before("agent.session_open", (input) => {
      const request = input.request as unknown as SessionOpenInput;
      const agentId = request.agentId;
      if (!agentId || request.env?.[PARENT_ENV]) {
        return undefined; // Child (parent env present) or missing ID: leave unchanged.
      }
      // Caller already supplied the door env (reloadAgentSession override) — do not overwrite it.
      if (request.env?.[DOOR_ENV]) return undefined;
      const url = opts.envDoorUrlFor(agentId, request.title ?? "main");
      if (!url) return undefined; // Ineligible or door not listening.
      const env = { ...(request.env ?? {}), [DOOR_ENV]: url };
      rt.log(`[paseo-subagents] env-door: agent ${agentId} reason=${request.reason ?? "?"} — ${DOOR_ENV} assigned (L2)`);
      return { ...request, env } as unknown as typeof input.request;
    });
  } catch (err) {
    rt.log(`[paseo-subagents] could not register session_open hook: ${err instanceof Error ? err.message : String(err)} — skipping`);
    return () => {};
  }
}
