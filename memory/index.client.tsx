import type { PluginClientContext } from "@getpaseo/plugin/client";
import { z } from "zod";
import { MemoryPanel } from "./client/panel.js";

/**
 * memory plugin (#181, P4 of the memory part 2 plan 2026-09-21): panel over
 * the engine's facts-status projection + the USER-only un-tombstone door.
 * Read-only otherwise — the store's writers live engine-side (regex trigger,
 * memory-curator); the model has no write path (memory-guard, P1d).
 */
export default function contribute(client: PluginClientContext) {
	// Doorbell wake-signal items (server/doorbell-server.ts, kind "doorbell" v1)
	// are renderer-less BY DESIGN — invisible wake pings, not content. App 0.8.0
	// shows "Plugin timeline item unavailable." for plugin items whose owning
	// plugin registers no renderer — register a null renderer so bells stay
	// invisible as designed (2026-09-22 UI audit).
	client.addTimelineRenderer({
		kind: "doorbell",
		version: 1,
		schema: z.object({ bell: z.string(), file: z.string(), ts: z.string() }),
		Component: () => null,
	});

	client.addWorkspacePanel({
		id: "memory",
		title: "Memory",
		icon: "Database",
		context: "workspace",
		Component: MemoryPanel,
	});

	client.addCommandCenterItem({
		id: "memory-open",
		title: "Memory: durable facts tier",
		icon: "Database",
		keywords: ["memory", "facts", "curator", "tombstone", "preference", "convention"],
		context: "workspace",
		onSelect(context_) {
			context_.openPanel("memory");
		},
	});

	// App runtime contract: contribute() MUST return a cleanup function
	// (runPluginClientBundle throws "Plugin memory contribution must return a
	// cleanup function" otherwise — memory items rendered unavailable since
	// v1.0.0; found via the app's plugin evaluation errors, F9 2026-09-22).
	return () => {};
}
