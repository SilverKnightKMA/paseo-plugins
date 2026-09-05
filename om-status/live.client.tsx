import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useRpc, type PluginClientContext, type PluginComposerPillProps } from "@getpaseo/plugin";
import { GetOmStatusRpc, type OmStatusState } from "./rpc.js";

/**
 * ComposerPill registration. Pills are matched STRICTLY by
 * (serverId, workspaceId, agentId) — no wildcards — and the client
 * contribution runs once per installation, so we enumerate all agents via
 * paseo.agents.list() and register one pill per (workspace, agent) pair.
 * agents.subscribe + a 30s diff loop keeps new chats covered.
 */
export function startOmLive(client: PluginClientContext): () => void {
  const cleanups: Array<() => void> = [];
  const registered = new Set<string>();

  async function sync(): Promise<void> {
    try {
      const res = await client.paseo.agents.list();
      const seen = new Set<string>();
      for (const agent of res.entries) {
        const workspaceId = (agent as { workspaceId?: string | null }).workspaceId;
        const agentId = (agent as { id?: string }).id;
        if (!workspaceId || !agentId) continue;
        const key = `${workspaceId}/${agentId}`;
        seen.add(key);
        if (registered.has(key)) continue;
        const cleanup = client.addComposerPill({
          id: `om-status-pill-${key}`,
          title: "OM",
          workspaceId,
          agentId,
          Component: OmPill,
          onPress: () => {
            void client.openPanel("om-status", { workspaceId, agentId });
          },
        });
        registered.add(key);
        cleanups.push(cleanup);
      }
      // release pills whose agents disappeared
      for (const key of [...registered]) {
        if (!seen.has(key)) {
          registered.delete(key);
        }
      }
    } catch {
      // daemon offline / RPC hiccup — retry on the next tick
    }
  }

  void sync();
  const unsub = client.paseo.agents.subscribe(() => void sync());
  const timer = setInterval(() => void sync(), 30_000);
  return () => {
    unsub();
    clearInterval(timer);
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
}

const POLL_MS = 2000;

const ICON: Record<string, string> = { working: "⏳", warning: "⚠️", healthy: "✓" };

/** The live gauge itself — same data contract as the panel, compressed. */
export function OmPill(props: PluginComposerPillProps) {
  const read = useRpc(GetOmStatusRpc);
  const [data, setData] = useState<OmStatusState | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await read({ workspaceId: props.workspaceId });
      if (mounted.current) setData(next);
    } catch {
      // keep the last snapshot; next poll retries
    }
  }, [props.workspaceId, read]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  if (!data?.present || !data.summary) {
    return (
      <Text style={{ opacity: 0.5 }}>
        om · {data?.present ? "…" : "off"}
      </Text>
    );
  }
  const s = data.summary;
  const ctx = s.contextTokens != null ? `ctx ${Math.round((s.contextTokens / s.contextMax) * 100)}%` : "ctx ?";
  const workers =
    s.verdict === "working"
      ? s.observersRunning > 0
        ? `om ${s.observersRunning}/${s.observerSlots}`
        : "om c"
      : "om ✓";
  return (
    <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
      <Text>{ICON[s.verdict] ?? "•"}</Text>
      <Text>
        {workers} · {ctx}
      </Text>
      <Text style={{ opacity: 0.6 }}>
        ${s.sessionCostUsd.toFixed(2)} · {s.sessionRuns}r
      </Text>
    </View>
  );
}
