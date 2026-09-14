import type { PluginServerContext } from "@getpaseo/plugin/server";
import { GetPlanStateRpc, SetPlanControlRpc } from "./shared/rpc.js";
import { readPlanState, writePlanControl } from "./server/plan-state.js";

export default function contribute(server: PluginServerContext) {
  server.handle(GetPlanStateRpc, async (input, context) => readPlanState(input, context));
  server.handle(SetPlanControlRpc, async (input) => writePlanControl(input));
  return () => {};
}
