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
import { listenReplyServer, type ReplyServerHandle } from "./server/mcp-server.js";
import { registerSubagentReplyHook } from "./server/hooks.js";

/** Structural slice of the SDK API the door needs (avoids importing
 *  @getpaseo/client, which is not a plugin-SDK specifier). */
interface PaseoSendSlice {
  agents: { ref(id: string): { send(text: string): Promise<void> } };
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

  let replyServer: ReplyServerHandle | null = null;
  listenReplyServer({
    registry,
    deliver: (parentId, title, prompt) => {
      const api = paseoApi;
      if (!api) return Promise.reject(new Error("paseo API not captured yet — daemon lifecycle context missing"));
      return api.agents.ref(parentId).send(`[child-report] ${title}: ${prompt}`);
    },
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

  const offCreated = server.on("agent.created", (_event, context) => capturePaseo(context.paseo));
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
