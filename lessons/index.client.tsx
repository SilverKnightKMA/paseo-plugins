import type { PluginClientContext } from "@getpaseo/plugin/client";
import { LessonsPanel } from "./client/panel.js";
import { LessonsChip } from "./client/lessons-chip.js";
import { LessonsChipSchema } from "./client/schema.js";

import { parseLessonsBlock } from "./shared/parser.js";

export default function contribute(client: PluginClientContext) {
	// ── panel (#110a): sidebar-reachable lessons list ──────────────────────
	client.addWorkspacePanel({
		id: "lessons",
		title: "Lessons",
		icon: "GraduationCap",
		context: "workspace",
		Component: LessonsPanel,
	});

	client.addCommandCenterItem({
		id: "lessons-open",
		title: "Lessons: bài học đã fold theo session",
		icon: "GraduationCap",
		keywords: ["lessons", "memory", "failure", "convention", "preference"],
		context: "workspace",
		onSelect(context_) {
			context_.openPanel("lessons");
		},
	});

	// ── timeline chip (#110b): hide the injected block, keep model context ─
	// The engine injects the lessons block as a custom message
	// (customType "lessons-context", display:false for the model's benefit).
	// The pi provider surfaces it as an assistant_message; without this
	// transformer the raw multi-line block renders inline in the timeline.
	client.addTimelineTransformer({
		id: "lessons-block-transformer",
		query: { itemType: "assistant_message" },
		transform: ({ item }) => {
			if (item.type !== "assistant_message") return undefined;
			const parsed = parseLessonsBlock(item.text ?? "");
			if (!parsed) return undefined;
			return {
				items: [
					{
						type: "plugin" as const,
						kind: "lessons-chip",
						version: 1,
						data: parsed,
					},
				],
			};
		},
	});

	client.addTimelineRenderer({
		kind: "lessons-chip",
		version: 1,
		schema: LessonsChipSchema,
		Component: LessonsChip,
	});

	return () => {};
}
