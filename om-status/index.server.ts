import type { PluginServerContext } from "@getpaseo/plugin/server";
import { GetOmStatusRpc } from "./shared/rpc.js";
import { readOmStatus } from "./server/om-status.js";

export default function contribute(server: PluginServerContext) {
  server.handle(GetOmStatusRpc, async (input, context) => readOmStatus(input, context));
  return () => {};
}
