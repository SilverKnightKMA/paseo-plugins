import type { PluginServerContext } from "@getpaseo/plugin/server";
import { GetOmStatusRpc, GetOmTopicsRpc } from "./shared/rpc.js";
import { readOmStatus, readOmTopics } from "./server/om-status.js";
import { createDoorbellServer, safeOnDoorbellCapture } from "./server/doorbell-server.js";

export default function contribute(server: PluginServerContext) {
  // #39 doorbell: own the "om-status" bell — append invisible timeline items
  // so subscribed panels (om-status pill + om-panel) refetch within ms.
  const bell = createDoorbellServer("om-status", ["om-status"], { log: (m) => console.log(`[om-status] ${m}`) });
  bell.start();
  safeOnDoorbellCapture(server, bell);
  try {
    server.handle(GetOmStatusRpc, async (input, context) => {
      bell.setPaseo(context.paseo);
      return readOmStatus(input, context);
    });
  } catch (err) {
    console.error("[om-status] GetOmStatusRpc handle failed:", err);
  }
  // #244 (M3): topics listing — on-demand, read-only, no bell (cheap + rare).
  try {
    server.handle(GetOmTopicsRpc, async (_input, context) => readOmTopics(_input, context));
  } catch (err) {
    console.error("[om-status] GetOmTopicsRpc handle failed:", err);
  }
  return () => {
    void bell.stop();
  };
}
