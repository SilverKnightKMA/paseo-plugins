import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useAgent, useRpc, type PluginTimelineItemProps } from "@getpaseo/plugin";
import { GetOmStatusRpc, type OmStatusState } from "./rpc.js";

const POLL_MS = 10_000;

/**
 * "om checkpoint" card rendered at compaction points in the chat timeline.
 * The transformer replaced the compaction item 1:1 (its data rides along);
 * the card itself is pure client render — model-invisible. The renderer has
 * agentId, so it resolves the agent's OWN workspace and reads that
 * workspace's newest om-status.json — cards stay per-workspace correct even
 * when several run concurrently.
 *
 * Visual: a real card, not naked text — surface background, hairline border,
 * blue accent rail on the left, neutral "om" badge instead of an emoji
 * (emoji render as clashing pink on Android), theme-muted secondary lines.
 */
export function OmHistoryCard(props: PluginTimelineItemProps<{ compaction: { status: string; trigger: string | null; preTokens: number | null } }>) {
  const workspaceId = useAgent(props.agentId, (agent) => agent.workspaceId);
  const read = useRpc(GetOmStatusRpc);
  const [data, setData] = useState<OmStatusState | null>(null);
  const c = props.theme.colors;

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    try {
      setData(await read({ workspaceId, agentId: props.agentId }));
    } catch {
      // keep last snapshot
    }
  }, [workspaceId, props.agentId, read]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const comp = props.item.data.compaction;
  const s = data?.summary;
  const empty = data != null && !data.present;

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        backgroundColor: c.surface1,
        borderColor: c.border,
        borderWidth: 1,
        borderLeftColor: c.accent,
        borderLeftWidth: 3,
        borderRadius: 8,
        paddingVertical: 8,
        paddingHorizontal: 10,
        marginVertical: 4,
        gap: 8,
        opacity: empty ? 0.6 : 1,
      }}
    >
      <View
        style={{
          backgroundColor: c.surface2,
          borderColor: c.border,
          borderWidth: 1,
          borderRadius: 6,
          paddingHorizontal: 6,
          paddingVertical: 2,
          marginTop: 1,
        }}
      >
        <Text style={{ color: c.accent, fontFamily: "monospace", fontWeight: "700" as const, fontSize: 11 }}>om</Text>
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: c.foreground, fontWeight: "600" as const, fontSize: 13 }}>
          checkpoint{comp.trigger ? ` · ${comp.trigger}` : ""}
          {comp.preTokens != null ? ` · context ${(comp.preTokens / 1000).toFixed(0)}k tok` : ""}
        </Text>
        {s ? (
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
            ${s.sessionCostUsd.toFixed(2)} · {s.sessionRuns} runs · pool{" "}
            {Math.round((s.poolTokens / s.poolMax) * 100)}%
            {s.contextTokens != null ? ` · ctx ${Math.round((s.contextTokens / s.contextMax) * 100)}%` : ""}
          </Text>
        ) : (
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
            {empty ? "om off / no data yet" : "loading…"}
          </Text>
        )}
        {data?.events && data.events.length > 0 ? (
          <Text style={{ color: c.foregroundMuted, fontSize: 11, marginTop: 2 }} numberOfLines={1}>
            {Array.from(
              new Set(
                data.events.slice(0, 3).map((e) => e.text.split("\n")[0].trim()),
              ).values(),
            )
              .slice(0, 2)
              .join("  ·  ")}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
