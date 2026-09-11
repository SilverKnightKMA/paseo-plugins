import type { PluginServerContext } from "@getpaseo/plugin/server";
import { GetOmStateRpc } from "./shared/rpc.js";
import { omStateHandler } from "./server/om-state.js";

export default function contribute(server: PluginServerContext) {
  server.handle(GetOmStateRpc, omStateHandler);
  return () => {};
}
