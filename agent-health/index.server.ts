import type { PluginServerContext } from "@getpaseo/plugin/server";
import { GetStateRpc, GetZwAlertRpc } from "./shared/rpc.js";
import { healthStateHandler, zwAlertHandler } from "./server/health-state.js";

export default function contribute(server: PluginServerContext) {
  server.handle(GetStateRpc, healthStateHandler);
  server.handle(GetZwAlertRpc, zwAlertHandler);
  return () => {};
}
