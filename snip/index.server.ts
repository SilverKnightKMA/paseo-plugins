import type { PluginServerContext } from "@getpaseo/plugin/server";
import { GetSnipStateRpc, SetSnipStateRpc } from "./shared/rpc.js";
import { readSnipState, writeSnipState } from "./server/snip-state.js";

export default function contribute(server: PluginServerContext) {
  server.handle(GetSnipStateRpc, async (input, context) => readSnipState(input, context));

  server.handle(SetSnipStateRpc, async (input) => {
    try {
      return await writeSnipState(input);
    } catch {
      return { ok: false, sentAt: "", note: "write failed — is ~/.pi/agent/snip-control writable?" };
    }
  });

  return () => {};
}
