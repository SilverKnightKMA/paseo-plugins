import type { PluginServerContext } from "@getpaseo/plugin/server";
import { GetTaskStateRpc, SetTaskControlRpc, GetGoalStateRpc, SetGoalControlRpc, GetPlanStateRpc, SetPlanControlRpc } from "./shared/rpc.js";
import { readTaskState, writeTaskControl } from "./server/task-state.js";
import { readPlanState, writePlanControl } from "./server/plan-state.js";
import { readGoalState, writeGoalControl } from "./server/goal-state.js";

export default function contribute(server: PluginServerContext) {
  server.handle(GetTaskStateRpc, async (input, context) => readTaskState(input, context));

  server.handle(SetTaskControlRpc, async (input) => {
    try {
      return await writeTaskControl(input);
    } catch {
      return { ok: false, sentAt: "", note: "write failed — is ~/.pi/agent/task-control writable?" };
    }
  });

  // #37 (v1.0.40): goal draft/init — bảng duyệt scope.
  server.handle(GetGoalStateRpc, async (input) => readGoalState(input));
  server.handle(SetGoalControlRpc, async (input) => {
    try {
      return await writeGoalControl(input);
    } catch {
      return { ok: false, sentAt: "", note: "write failed — ~/.pi/agent/goal-control writable?" };
    }
  });

  // #22 (v1.0.37): plan-mode status projection + the user-only approve door.
  server.handle(GetPlanStateRpc, async (input) => readPlanState(input));
  server.handle(SetPlanControlRpc, async (input) => {
    try {
      return await writePlanControl(input);
    } catch {
      return { ok: false, sentAt: "", note: "write failed — is ~/.pi/agent/plan-control writable?" };
    }
  });

  return () => {};
}
