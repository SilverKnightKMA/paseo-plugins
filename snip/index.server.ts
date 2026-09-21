import type { PluginServerContext } from "@getpaseo/plugin/server";
import { GetSnipStateRpc, SetSnipStateRpc } from "./shared/rpc.js";
import { readSnipState, writeSnipState } from "./server/snip-state.js";
import { createDoorbellServer, safeOnDoorbellCapture } from "./server/doorbell-server.js";

export default function contribute(server: PluginServerContext) {
  // #39 doorbell: own the "snip-control" bell (chips refresh on engine ack).
  const bell = createDoorbellServer("snip", ["snip-control"]);
  bell.start();
  safeOnDoorbellCapture(server, bell);
  server.handle(GetSnipStateRpc, async (input, context) => {
    bell.setPaseo(context.paseo);
    return readSnipState(input, context);
  });

  server.handle(SetSnipStateRpc, async (input) => {
    try {
      return await writeSnipState(input);
    } catch {
      return { ok: false, sentAt: "", note: "write failed — is ~/.pi/agent/snip-control writable?" };
    }
  });

  return () => {};
}
