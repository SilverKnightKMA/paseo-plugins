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
import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import type { TokenRegistry } from "./tokens.js";
import { checkFloor, isNormalizedMode, providerFamily, translateMode } from "./mode-table.js";

export const PARENT_ENV = "PASEO_PARENT_AGENT_ID";
export const MODE_ENV = "PASEO_CHILD_MODE";

export interface SubagentReplyRuntime {
  registry: TokenRegistry;
  /** Current listener port, or null until the socket is bound. */
  getPort: () => number | null;
  allowFull: boolean;
  log: (message: string) => void;
}

export interface AgentCreateInput {
  config: AgentSessionConfig;
  env?: Record<string, string>;
}

export function rewriteChildConfig(input: AgentCreateInput, rt: SubagentReplyRuntime): AgentCreateInput {
  const env = { ...(input.env ?? {}) };
  const parentId = env[PARENT_ENV];
  if (!parentId) return input; // regular agent: untouched

  const requestedRaw = env[MODE_ENV];
  if (requestedRaw !== undefined && !isNormalizedMode(requestedRaw)) {
    throw new Error(
      `[subagent-reply] invalid ${MODE_ENV} '${requestedRaw}': expected one of read-only|auto|review|full — refusing spawn (fail-closed)`,
    );
  }

  const family = providerFamily(input.config.provider);
  if (requestedRaw !== undefined) {
    const floor = checkFloor(input.config.provider, requestedRaw, rt.allowFull);
    if (!floor.ok) {
      throw new Error(`[subagent-reply] spawn refused (fail-closed): ${floor.reason}`);
    }
  }

  const port = rt.getPort();
  if (port === null) {
    throw new Error("[subagent-reply] reply door is not listening yet — retry the spawn in a moment");
  }

  const title = input.config.title ?? "subagent";
  const token = rt.registry.mint(parentId, title);

  const mcpServers = {
    ...(input.config.mcpServers ?? {}),
    paseo: {
      type: "http" as const,
      url: `http://127.0.0.1:${port}/mcp?caller=${token}`,
      alwaysLoad: true,
    },
  };
  const config: AgentSessionConfig = { ...input.config, mcpServers };

  if (requestedRaw !== undefined) {
    const decision = translateMode(input.config.provider, requestedRaw);
    if (decision.modeId !== undefined) config.modeId = decision.modeId;
    if (decision.warning) rt.log(`[subagent-reply] ${family}: ${decision.warning}`);
  }

  delete env[PARENT_ENV];
  delete env[MODE_ENV];

  rt.log(`[subagent-reply] scoped reply door: child '${title}' (family=${family}) -> parent ${parentId}`);
  return { config, env };
}

export function registerSubagentReplyHook(server: PluginServerContext, rt: SubagentReplyRuntime): () => void {
  return server.before("agent.create", ({ request }) => rewriteChildConfig(request as AgentCreateInput, rt));
}
