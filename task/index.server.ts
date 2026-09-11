import type { PluginServerContext } from "@getpaseo/plugin/server";
import { GetTaskStateRpc, SetTaskControlRpc } from "./shared/rpc.js";
import { readTaskState, writeTaskControl } from "./server/task-state.js";

export default function contribute(server: PluginServerContext) {
  server.handle(GetTaskStateRpc, async (input, context) => readTaskState(input, context));

  server.handle(SetTaskControlRpc, async (input) => {
    try {
      return await writeTaskControl(input);
    } catch {
      return { ok: false, sentAt: "", note: "write failed — is ~/.pi/agent/task-control writable?" };
    }
  });

  return () => {};
}
