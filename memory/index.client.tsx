import type { PluginClientContext } from "@getpaseo/plugin/client";
import { MemoryPanel } from "./client/panel.js";

/**
 * memory plugin (#181, P4 of the memory part 2 plan 2026-09-21): panel over
 * the engine's facts-status projection + the USER-only un-tombstone door.
 * Read-only otherwise — the store's writers live engine-side (regex trigger,
 * memory-curator); the model has no write path (memory-guard, P1d).
 */
export default function contribute(client: PluginClientContext) {
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
}
