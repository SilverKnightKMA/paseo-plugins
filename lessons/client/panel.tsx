import React from "react";
import { ScrollView, Text, View } from "react-native";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { GetLessonsStateRpc, type LessonRow, type LessonsState } from "../shared/rpc.js";
import { useLiveRpc } from "./use-live.js";

const BACKSTOP_MS = 30_000; // a lessons file changes rarely; backstop only

const TAG_COLORS: Record<string, "statusDanger" | "statusWarning" | "accent"> = {
	failure: "statusDanger",
	convention: "statusWarning",
	preference: "accent",
};

function timeAgo(iso: string | null): string {
	if (!iso) return "?";
	const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

function LessonItem({ c, row }: { c: PluginWorkspacePanelProps["theme"]["colors"]; row: LessonRow }) {
	const tagColorKey = TAG_COLORS[row.tag] ?? "foregroundMuted";
	const tagColor = c[tagColorKey as keyof typeof c] as string | undefined;
	return (
		<View style={{ marginBottom: 6, paddingLeft: 6, borderLeftWidth: 2, borderLeftColor: tagColor ?? c.border }}>
			<View style={{ flexDirection: "row", gap: 8, marginBottom: 1 }}>
				<Text style={{ color: tagColor ?? c.foregroundMuted, fontSize: 11, fontWeight: "600" }}>
					{row.tag}
				</Text>
				<Text style={{ color: c.foregroundMuted, fontSize: 11, marginLeft: "auto" }}>
					{row.date} · {row.ageDays}d old
				</Text>
			</View>
			<Text style={{ color: c.foreground, fontSize: 12 }}>{row.text}</Text>
		</View>
	);
}

/**
 * Lessons panel (#110): human-facing list of the folded lessons the engine
 * injects into model context. Read-only — the file's single writer stays the
 * OM consolidator (engine side).
 */
export function LessonsPanel({ theme }: PluginWorkspacePanelProps) {
	const getState = useRpc(GetLessonsStateRpc);
	const [data, setData] = React.useState<LessonsState | null>(null);
	const [error, setError] = React.useState<string | null>(null);

	const load = React.useCallback(async () => {
		try {
			setData(await getState({}));
			setError(null);
		} catch (err) {
			setError(String(err));
		}
	}, [getState]);

	useLiveRpc(load, BACKSTOP_MS);

	const c = theme.colors;
	const groups = React.useMemo(() => {
		const byTag = new Map<string, LessonRow[]>();
		for (const row of data?.lessons ?? []) {
			const list = byTag.get(row.tag) ?? [];
			list.push(row);
			byTag.set(row.tag, list);
		}
		// deterministic order: known tags first (failure, convention, preference), then others
		const known = ["failure", "convention", "preference"];
		return [...byTag.entries()].sort((a, b) => {
			const ai = known.indexOf(a[0]);
			const bi = known.indexOf(b[0]);
			return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a[0].localeCompare(b[0]);
		});
	}, [data]);

	return (
		<ScrollView style={{ flex: 1, backgroundColor: c.surface0, padding: 12 }}>
			<View style={{ marginBottom: 10, gap: 2 }}>
				<Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>
					Lessons from past sessions {data ? `· ${data.total}` : ""}
				</Text>
				<Text style={{ color: c.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
					{data?.present
						? `source: ${data.file} · updated ${timeAgo(data.mtime)}`
						: (data?.note ?? "…")}
				</Text>
			</View>

			{error ? <Text style={{ color: c.statusDanger, fontSize: 11 }}>rpc error: {error}</Text> : null}

			{groups.map(([tag, rows]) => (
				<View key={tag} style={{ marginBottom: 12, gap: 4 }}>
					<Text style={{ color: c.foregroundMuted, fontSize: 11, fontWeight: "600", textTransform: "uppercase" }}>
						{tag} ({rows.length})
					</Text>
					{rows.map((row, i) => (
						<LessonItem key={`${row.date}-${i}`} c={c} row={row} />
					))}
				</View>
			))}

			{data?.present && data.total === 0 ? (
				<Text style={{ color: c.foregroundMuted, fontSize: 11 }}>file present but has no valid lesson lines</Text>
			) : null}
		</ScrollView>
	);
}
