import type { PluginServerContext } from "@getpaseo/plugin/server";
import { GetLessonsStateRpc } from "./shared/rpc.js";
import { lessonsStateHandler } from "./server/lessons-state.js";

export default function contribute(server: PluginServerContext) {
	server.handle(GetLessonsStateRpc, lessonsStateHandler);
	return () => {};
}
