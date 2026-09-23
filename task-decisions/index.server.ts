import type { PluginServerContext } from "@getpaseo/plugin/server";
import { GetDecisionsRpc, PokeControlRpc } from "./shared/rpc.js";
import { readDecisions, pokeControl } from "./server/decisions.js";

export default function contribute(server: PluginServerContext) {
  // #244 lesson: guard every registration — one throw must not kill the plugin.
  try {
    server.handle(GetDecisionsRpc, (input, context) => readDecisions(input, context));
  } catch (err) {
    console.error("[task-decisions] GetDecisionsRpc handle failed:", err);
  }
  try {
    server.handle(PokeControlRpc, async (input) => pokeControl(input));
  } catch (err) {
    console.error("[task-decisions] PokeControlRpc handle failed:", err);
  }
  return () => {
    // nothing to stop (no bell server — panels poll + refetch after pokes)
  };
}
