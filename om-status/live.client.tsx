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
      // wire entries are { agent: <snapshot> } wrappers — unwrap
      const agents = res.entries
        .map((e) => (e as { agent?: { id?: string; workspaceId?: string | null } }).agent)
        .filter((a): a is { id: string; workspaceId: string } => Boolean(a?.id && a?.workspaceId));
      for (const agent of agents) {
        const workspaceId = agent.workspaceId;
        const agentId = agent.id;
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

/** Verdict glyph + color — theme-driven, no emoji (renders pink/clashing). */
function verdictMark(verdict: string, c: { statusSuccess: string; statusWarning: string; foregroundMuted: string }): { glyph: string; color: string } {
  if (verdict === "healthy") return { glyph: "✓", color: c.statusSuccess };
  if (verdict === "warning") return { glyph: "!", color: c.statusWarning };
  return { glyph: "…", color: c.foregroundMuted };
}

/** The live gauge itself — same data contract as the panel, compressed. */
export function OmPill(props: PluginComposerPillProps) {
  const read = useRpc(GetOmStatusRpc);
  const [data, setData] = useState<OmStatusState | null>(null);
  const mounted = useRef(true);
  const c = props.theme.colors;

  const refresh = useCallback(async () => {
    try {
      const next = await read({ workspaceId: props.workspaceId, agentId: props.agentId });
      if (mounted.current) setData(next);
    } catch {
      // keep the last snapshot; next poll retries
    }
  }, [props.workspaceId, props.agentId, read]);

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
      <View
        style={{
          backgroundColor: c.surface1,
          borderColor: c.border,
          borderWidth: 1,
          borderRadius: 999,
          paddingHorizontal: 10,
          paddingVertical: 3,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
        }}
      >
        <Text style={{ color: c.foregroundMuted, fontFamily: "monospace", fontWeight: "700" as const, fontSize: 11 }}>om</Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{data?.present ? "…" : "off"}</Text>
      </View>
    );
  }
  const s = data.summary;
  const ctx = s.contextTokens != null ? `ctx ${Math.round((s.contextTokens / s.contextMax) * 100)}%` : "ctx ?";
  const workers =
    s.verdict === "working" ? (s.observersRunning > 0 ? `${s.observersRunning}/${s.observerSlots}` : "c") : "✓";
  const mark = verdictMark(s.verdict, c);
  return (
    <View
      style={{
        backgroundColor: c.surface2,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: 10,
        paddingVertical: 3,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
      }}
    >
      <Text style={{ color: c.accent, fontFamily: "monospace", fontWeight: "700" as const, fontSize: 11 }}>om</Text>
      <Text style={{ color: mark.color, fontSize: 12, fontWeight: "700" as const }}>{mark.glyph}</Text>
      <Text style={{ color: c.foreground, fontSize: 12 }}>{workers}</Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{ctx}</Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
        ${s.sessionCostUsd.toFixed(2)} · {s.sessionRuns}r
      </Text>
    </View>
  );
}
