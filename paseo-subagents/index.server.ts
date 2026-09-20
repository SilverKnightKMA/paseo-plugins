/**
 * paseo-subagents — scoped child->parent reply door for Paseo.
 *
 * Children created with env PASEO_PARENT_AGENT_ID (= "this is a subagent of
 * X", carried by the `paseo run --env` / create_agent_request protocol path)
 * lose the daemon's full MCP catalog and gain exactly one tool:
 * reply_to_parent(prompt). The door resolves the caller to its parent by the
 * opaque token minted at create; no agentId is addressable from the child.
 *
 * NOTE the plugin contract: the default export must be SYNCHRONOUS and return
 * a cleanup function (the plugin process checks the return type before any
 * await — an async contribution is rejected at load time).
 *
 * Env (read once at plugin start):
 *   SUBAGENT_REPLY_ALLOW_FULL=1  — opt in to spawning children with mode=full
 *                                  (fail-closed floor refuses it otherwise)
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PluginCleanup } from "@getpaseo/plugin";
import { TokenRegistry } from "./server/tokens.js";
import { listenReplyServer, type ReplyServerHandle, type SpawnFn } from "./server/mcp-server.js";
import { registerSubagentReplyHook, PARENT_ENV } from "./server/hooks.js";
import { composeInitialPrompt, resolveRole, type PluginSettings } from "./server/roles.js";

/** Max depth tuyệt đối (spec mục 6): main=0 → con=1 → cháu=2. */
const MAX_DEPTH = 2;

/** Structural slice of the SDK API the door needs (avoids importing
 *  @getpaseo/client, which is not a plugin-SDK specifier). */
interface PaseoSendSlice {
  agents: {
    ref(id: string): { send(text: string): Promise<void> };
    create(options: {
      config: { provider: string; title?: string };
      parent?: string;
      labels?: Record<string, string>;
      prompt?: string;
      env?: Record<string, string>;
      cwd: string;
    }): Promise<{ id: string }>;
  };
}

export default function contribute(server: PluginServerContext): PluginCleanup {
  const registry = new TokenRegistry();
  const allowFull = process.env.SUBAGENT_REPLY_ALLOW_FULL === "1";

  // The plugin server context does not hand us a PaseoApi directly; hook and
  // event contexts do. Delivery can only happen after some lifecycle context
  // has been observed (a child must have been created to call the door), so
  // capturing lazily is safe by ordering.
  let paseoApi: PaseoSendSlice | null = null;
  const capturePaseo = (api: PaseoSendSlice): void => {
    paseoApi ??= api;
  };

  const settings: PluginSettings = {}; // repo wins: settings file sẽ được nạp ở increment sau

  const spawnFn: SpawnFn = async (caller, args) => {
    const api = paseoApi;
    if (!api) return { error: "paseo API not captured yet — daemon lifecycle context missing" };
    if (caller.depth >= MAX_DEPTH) {
      return { error: `depth cap: caller depth=${caller.depth}, max=${MAX_DEPTH} (spec mục 6 — kìm đệ quy)` };
    }
    const resolved = resolveRole(args.role, settings);
    if (!resolved.ok) return { error: resolved.error };
    const { role } = resolved;
    const title = args.name ?? `${args.role}: ${args.task.slice(0, 40)}`;
    const initialPrompt = composeInitialPrompt(role, args.task);
    const labels: Record<string, string> = {
      "subagent.role": args.role,
      "subagent.depth": String(caller.depth + 1),
      ...(caller.boundAgentId ? { "subagent.parent": caller.boundAgentId } : {}),
    };
    // Env carrier: hook before(agent.create) mint door cho child (depth+1, canSpawn theo role).
    const env: Record<string, string> = {
      ...role.env,
      ...(caller.boundAgentId ? { [PARENT_ENV]: caller.boundAgentId } : {}),
    };
    try {
      const child = await api.agents.create({
        config: { provider: role.providerEntry, title },
        parent: caller.boundAgentId,
        labels,
        prompt: initialPrompt,
        env,
        cwd: process.cwd(), // TODO(E2E): lấy cwd của caller agent khi slice mở rộng
      });
      console.log(`[paseo-subagents] spawn_subagent: role=${args.role} provider=${role.providerEntry} -> agent ${child.id} (depth ${caller.depth + 1})`);
      return { agentId: child.id };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  let replyServer: ReplyServerHandle | null = null;
  listenReplyServer({
    registry,
    deliver: (parentId, title, prompt) => {
      const api = paseoApi;
      if (!api) return Promise.reject(new Error("paseo API not captured yet — daemon lifecycle context missing"));
      return api.agents.ref(parentId).send(`[child-report] ${title}: ${prompt}`);
    },
    spawn: spawnFn,
  })
    .then((handle) => {
      replyServer = handle;
      console.log(
        `[paseo-subagents] listening on 127.0.0.1:${handle.port} (allowFull=${allowFull ? "1" : "0"}); ` +
          `spawn children with --env PASEO_PARENT_AGENT_ID[=id][,PASEO_CHILD_MODE=knob] to get the scoped door`,
      );
    })
    .catch((err: unknown) => {
      console.error(`[paseo-subagents] FAILED to listen: ${err instanceof Error ? err.message : String(err)}`);
    });

  const offCreated = server.on("agent.created", (event: unknown, context: { paseo: PaseoSendSlice }) => {
    capturePaseo(context.paseo);
    // Bind token door → agentId cho main (main mint token TRƯỚC khi có id).
    const record = event as { agentId?: string; config?: { mcpServers?: Record<string, { url?: string }> } };
    if (record?.agentId && record.config?.mcpServers) {
      const entry = record.config.mcpServers["paseo-subagents"] ?? record.config.mcpServers["paseo"];
      if (entry?.url) registry.findByUrl(entry.url)?.token && registry.bind(new URL(entry.url).searchParams.get("caller") as string, record.agentId);
    }
  });
  const offHook = registerSubagentReplyHook(server, {
    registry,
    // Port is bound on the next event-loop turn after contribute returns;
    // the daemon cannot deliver a create request to the plugin before then.
    // If it somehow does, the hook throws an honest error below.
    getPort: () => replyServer?.port ?? null,
    allowFull,
    log: (message) => console.log(message),
  });

  return () => {
    offHook();
    offCreated();
    replyServer?.close();
  };
}
