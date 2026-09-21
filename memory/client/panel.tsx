import React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { GetMemoryStateRpc, MemoryUntombstoneRpc, type FactRow } from "../shared/rpc.js";
import { useLiveRpc } from "./use-live.js";

const BACKSTOP_MS = 30_000; // facts change rarely; backstop only

const PRIORITY_COLOR: Record<string, "accent" | "statusWarning" | "foregroundMuted"> = {
	P1: "accent",
	P2: "statusWarning",
	P3: "foregroundMuted",
};

function timeAgo(iso: string | null): string {
	if (!iso) return "?";
	const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Memory panel (#181, P4): human-facing view of the durable facts tier.
 * Read-only + the USER-only un-tombstone button (control file → engine
 * applies; the model has no write path — memory-guard blocks it engine-side).
 */
export function MemoryPanel({ theme }: PluginWorkspacePanelProps) {
	const getState = useRpc(GetMemoryStateRpc);
	const untombstone = useRpc(MemoryUntombstoneRpc);
	const [data, setData] = React.useState<import("../shared/rpc.js").MemoryState | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const [busyId, setBusyId] = React.useState<string | null>(null);

	const load = React.useCallback(async () => {
		try {
			setData(await getState({}));
			setError(null);
		} catch (err) {
			setError(String(err));
		}
	}, [getState]);

	useLiveRpc(load, BACKSTOP_MS);

	const onUntombstone = React.useCallback(
		async (id: string) => {
			setBusyId(id);
			try {
				await untombstone({ id });
				// the engine acks asynchronously; give the watcher a moment
				setTimeout(() => void load(), 800);
			} catch (err) {
				setError(String(err));
			} finally {
				setBusyId(null);
			}
		},
		[untombstone, load],
	);

	const c = theme.colors;

	return (
		<ScrollView style={{ flex: 1, backgroundColor: c.surface0, padding: 12 }}>
			<View style={{ marginBottom: 10, gap: 2 }}>
				<Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>
					Memory · durable facts {data ? `· ${data.live} live / ${data.tombstoned} retired` : ""}
				</Text>
				<Text style={{ color: c.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
					{data?.present ? `source: ${data.file} · updated ${timeAgo(data.mtime)}` : (data?.note ?? "…")}
				</Text>
			</View>

			{data?.curatorFailing ? (
				<View style={{ marginBottom: 10, padding: 8, borderRadius: 6, backgroundColor: c.statusDanger + "22", borderLeftWidth: 3, borderLeftColor: c.statusDanger }}>
					<Text style={{ color: c.statusDanger, fontSize: 12, fontWeight: "600" }}>
						memory-curator failing ({data.failingStreak}x)
					</Text>
					{data.lastError ? (
						<Text style={{ color: c.foregroundMuted, fontSize: 11 }} numberOfLines={2}>
							{data.lastError}
						</Text>
					) : null}
					<Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
						counters stay crossed — the next successful run heals the debt automatically
					</Text>
				</View>
			) : null}

			{error ? <Text style={{ color: c.statusDanger, fontSize: 11 }}>rpc error: {error}</Text> : null}

			{data?.lastCuration ? (
				<View style={{ marginBottom: 10, padding: 8, borderRadius: 6, backgroundColor: c.surface1 }}>
					<Text style={{ color: c.foregroundMuted, fontSize: 11, fontWeight: "600" }}>last curation</Text>
					<Text style={{ color: c.foreground, fontSize: 12 }}>
						{data.lastCuration.outcome === "ok"
							? `${data.lastCuration.appliedVerdicts} retired · ${data.lastCuration.proposalsAdded} proposed`
							: data.lastCuration.outcome}{" "}
						· trigger {data.lastCuration.trigger} · {timeAgo(data.lastCuration.ts)}
					</Text>
					<Text style={{ color: c.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
						next when: ≥{data.nextThresholds.minLines} lines changed / ≥{Math.round(data.nextThresholds.minTokens / 1_000_000)}M tokens / ≥
						{data.nextThresholds.minSessions} sessions / {data.nextThresholds.floorDays}d floor
					</Text>
				</View>
			) : null}

			{data?.byCategory.filter((x) => x.live + x.tombstoned > 0).length ? (
				<View style={{ marginBottom: 12, gap: 4 }}>
					<Text style={{ color: c.foregroundMuted, fontSize: 11, fontWeight: "600", textTransform: "uppercase" }}>
						categories
					</Text>
					{data.byCategory
						.filter((x) => x.live + x.tombstoned > 0)
						.map((cat) => (
							<View key={cat.category} style={{ flexDirection: "row", gap: 8 }}>
								<Text style={{ color: c.foreground, fontSize: 12, minWidth: 90 }}>{cat.category}</Text>
								<Text style={{ color: c.accent, fontSize: 12 }}>{cat.live} live</Text>
								{cat.tombstoned > 0 ? (
									<Text style={{ color: c.foregroundMuted, fontSize: 12 }}>· {cat.tombstoned} retired</Text>
								) : null}
							</View>
						))}
				</View>
			) : null}

			{data?.tombstones.length ? (
				<View style={{ gap: 6 }}>
					<Text style={{ color: c.foregroundMuted, fontSize: 11, fontWeight: "600", textTransform: "uppercase" }}>
						retired facts (recovery span kept)
					</Text>
					{data.tombstones.map((row: FactRow) => (
						<DeadFact key={row.id} c={c} row={row} busy={busyId === row.id} onRestore={() => void onUntombstone(row.id)} />
					))}
					<Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
						un-tombstone is user-only: it queues a control file the engine applies
					</Text>
				</View>
			) : (
				<Text style={{ color: c.foregroundMuted, fontSize: 11 }}>no retired facts</Text>
			)}
		</ScrollView>
	);
}

function DeadFact({
	c,
	row,
	busy,
	onRestore,
}: {
	c: PluginWorkspacePanelProps["theme"]["colors"];
	row: FactRow;
	busy: boolean;
	onRestore: () => void;
}) {
	const prColorKey = PRIORITY_COLOR[row.priority] ?? "foregroundMuted";
	const prColor = c[prColorKey as keyof typeof c] as string | undefined;
	return (
		<View style={{ padding: 8, borderRadius: 6, backgroundColor: c.surface1, gap: 4 }}>
			<View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
				<Text style={{ color: c.foregroundMuted, fontSize: 11, fontWeight: "600" }}>
					{row.category} · {row.date} · #{row.id}
				</Text>
				<Text style={{ color: c.foregroundMuted, fontSize: 11, marginLeft: "auto" }}>
					{row.reason ?? "?"} · {row.tombstoned}
				</Text>
			</View>
			<Text style={{ color: c.foreground, fontSize: 12, textDecorationLine: "line-through" }} numberOfLines={2}>
				{row.text}
			</Text>
			<Pressable
				onPress={onRestore}
				disabled={busy}
				style={{ alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: prColor ?? c.border, opacity: busy ? 0.5 : 1 }}
			>
				<Text style={{ color: prColor ?? c.foregroundMuted, fontSize: 11, fontWeight: "600" }}>
					{busy ? "queued…" : "un-tombstone"}
				</Text>
			</Pressable>
		</View>
	);
}
