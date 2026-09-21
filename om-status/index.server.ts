import type { PluginServerContext } from "@getpaseo/plugin/server";
import { GetOmStatusRpc } from "./shared/rpc.js";
import { readOmStatus } from "./server/om-status.js";
import { createDoorbellServer, safeOnDoorbellCapture } from "./server/doorbell-server.js";

export default function contribute(server: PluginServerContext) {
  // #39 doorbell: own the "om-status" bell — append invisible timeline items
  // so subscribed panels (om-status pill + om-panel) refetch within ms.
  const bell = createDoorbellServer("om-status", ["om-status"], { log: (m) => console.log(`[om-status] ${m}`) });
  bell.start();
  safeOnDoorbellCapture(server, bell);
  server.handle(GetOmStatusRpc, async (input, context) => {
    bell.setPaseo(context.paseo);
    return readOmStatus(input, context);
  });
  return () => {
    void bell.stop();
  };
}
