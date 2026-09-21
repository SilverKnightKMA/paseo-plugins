import type { PluginServerContext } from "@getpaseo/plugin/server";
import { GetMemoryStateRpc, MemoryUntombstoneRpc } from "./shared/rpc.js";
import { memoryStateHandler, untombstoneHandler } from "./server/memory-state.js";
import { createDoorbellServer, safeOnDoorbellCapture } from "./server/doorbell-server.js";

export default function contribute(server: PluginServerContext) {
	// #39 doorbell: own the "facts-status" bell (memory panel refresh).
	const bell = createDoorbellServer("memory", ["facts-status"]);
	bell.start();
	safeOnDoorbellCapture(server, bell);
	server.handle(GetMemoryStateRpc, async (input, context) => {
		bell.setPaseo(context.paseo);
		return memoryStateHandler(input);
	});
	server.handle(MemoryUntombstoneRpc, untombstoneHandler);
	return () => {};
}
