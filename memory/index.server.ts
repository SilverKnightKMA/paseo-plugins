import type { PluginServerContext } from "@getpaseo/plugin/server";
import { GetMemoryStateRpc, MemoryUntombstoneRpc } from "./shared/rpc.js";
import { memoryStateHandler, untombstoneHandler } from "./server/memory-state.js";

export default function contribute(server: PluginServerContext) {
	server.handle(GetMemoryStateRpc, memoryStateHandler);
	server.handle(MemoryUntombstoneRpc, untombstoneHandler);
	return () => {};
}
