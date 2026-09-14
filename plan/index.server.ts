import type { PluginServerContext } from "@getpaseo/plugin/server";
import { GetPlanStateRpc, ListPlanSessionsRpc, SetPlanControlRpc } from "./shared/rpc.js";
import { readPlanState, listPlanSessions, writePlanControl } from "./server/plan-state.js";

export default function contribute(server: PluginServerContext) {
  server.handle(GetPlanStateRpc, async (input) => readPlanState(input));
  server.handle(ListPlanSessionsRpc, async () => ({ sessions: await listPlanSessions() }));
  server.handle(SetPlanControlRpc, async (input) => writePlanControl(input));
  return () => {};
}
