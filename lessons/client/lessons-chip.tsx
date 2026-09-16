import React from "react";
import { Text, View } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { LessonsChipData } from "./schema.js";

/**
 * One compact chip replacing the injected "Lessons from past sessions" block
 * (#110): the model still receives the full block in context (engine keeps
 * injecting — that is the vaccine); the human timeline shows a single dim
 * line instead. Render-layer only; the transcript message stays verbatim.
 */
export function LessonsChip(props: PluginTimelineItemProps<LessonsChipData>) {
	const d = props.item.data;
	const c = props.theme.colors;
	return (
		<View style={{ flexDirection: "row", gap: 6, alignItems: "center", paddingVertical: 2 }}>
			<Text style={{ color: c.foregroundMuted, fontSize: 11 }}>📚</Text>
			<Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
				{d.count} lessons injected into context (≤{d.maxAgeDays}d · panel has the list)
			</Text>
		</View>
	);
}
