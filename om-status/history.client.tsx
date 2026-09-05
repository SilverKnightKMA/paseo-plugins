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
 */
export function OmHistoryCard(props: PluginTimelineItemProps<{ compaction: { status: string; trigger: string | null; preTokens: number | null } }>) {
  const workspaceId = useAgent(props.agentId, (agent) => agent.workspaceId);
  const read = useRpc(GetOmStatusRpc);
  const [data, setData] = useState<OmStatusState | null>(null);

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

  return (
    <View style={{ paddingVertical: 6, gap: 3, opacity: data && !data.present ? 0.5 : 1 }}>
      <Text style={{ fontWeight: "600" }}>
        🧠 om checkpoint{comp.trigger ? ` (${comp.trigger})` : ""}
        {comp.preTokens != null ? ` · context was ${(comp.preTokens / 1000).toFixed(0)}k tok` : ""}
      </Text>
      {s ? (
        <Text>
          om since: ${s.sessionCostUsd.toFixed(2)} · {s.sessionRuns} runs · pool{" "}
          {Math.round((s.poolTokens / s.poolMax) * 100)}%
          {s.contextTokens != null ? ` · ctx now ${Math.round((s.contextTokens / s.contextMax) * 100)}%` : ""}
        </Text>
      ) : (
        <Text style={{ opacity: 0.6 }}>om status: chưa có dữ liệu (panel sẽ có sau turn đầu)</Text>
      )}
      {data?.events && data.events.length > 0 ? (
        <Text style={{ opacity: 0.6, fontSize: 12 }} numberOfLines={2}>
          {data.events.slice(0, 2).map((e) => e.text.split("\n")[0]).join(" · ")}
        </Text>
      ) : null}
    </View>
  );
}
