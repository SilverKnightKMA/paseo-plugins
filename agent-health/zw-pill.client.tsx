import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useRpc, type PluginClientContext, type PluginComposerPillProps } from "@getpaseo/plugin";
import { GetZwAlertRpc, type ZwAlertState } from "./rpc.js";

/**
 * Zombie-alert composer pill (2026-09-05, user-approved).
 * ZW is detect-only by design (no kill API; auto-kick walks into the
 * #3845 family), and since the v2 emission pivot its detections are silent
 * in chat (jsonl + Agent Health panel only). This pill restores visibility
 * the model-invisible way: 2s poll of the latest zombie-watchdog.jsonl
 * entry; a fresh (< 5 min) zombie/b2-settle-lost detection turns the pill
 * red with a STOP hint. No alert → renders nothing.
 */
export function startZwLive(client: PluginClientContext): () => void {
  const cleanups: Array<() => void> = [];
  const registered = new Set<string>();

  async function sync(): Promise<void> {
    try {
      const res = await client.paseo.agents.list();
      const seen = new Set<string>();
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
          id: `zw-pill-${key}`,
          title: "ZW",
          workspaceId,
          agentId,
          Component: ZwPill,
          onPress: () => {
            void client.openPanel("agent-health", { workspaceId, agentId });
          },
        });
        registered.add(key);
        cleanups.push(cleanup);
      }
      for (const key of [...registered]) {
        if (!seen.has(key)) registered.delete(key);
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
/** After this many consecutive RPC failures the pill shows a muted "zw ?" chip —
 *  a silent catch would make the pill vanish exactly when it is needed most
 *  (the 2026-09-05 "zombie without notification" report). */
const ERRORS_BEFORE_MUTE_CHIP = 3;

export function ZwPill(props: PluginComposerPillProps) {
  const read = useRpc(GetZwAlertRpc);
  const [data, setData] = useState<ZwAlertState | null>(null);
  const [errors, setErrors] = useState(0);
  const mounted = useRef(true);
  const c = props.theme.colors;

  const refresh = useCallback(async () => {
    try {
      const next = await read({ agentId: props.agentId });
      if (mounted.current) {
        setData(next);
        setErrors(0);
      }
    } catch {
      // keep last snapshot, but make persistent failures visible
      if (mounted.current) setErrors((n) => n + 1);
    }
  }, [props.agentId, read]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  if (data?.alert) {
    const who = data.agentId ? data.agentId.slice(0, 8) : "?";
    const mine = data.mine;
    return (
      <View
        style={{
          backgroundColor: mine ? c.statusDanger + "22" : c.surface1,
          borderColor: mine ? c.statusDanger : c.statusWarning,
          borderWidth: 1,
          borderRadius: 999,
          paddingHorizontal: 10,
          paddingVertical: 3,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
        }}
      >
        <Text style={{ color: mine ? c.statusDanger : c.statusWarning, fontWeight: "700" as const, fontSize: 12 }}>⚠</Text>
        <Text style={{ color: mine ? c.statusDanger : c.statusWarning, fontSize: 12, fontWeight: "700" as const }}>
          {mine ? "ZOMBIE — bấm STOP" : `zw ${who}`}
        </Text>
        <Text style={{ color: c.foregroundMuted, fontFamily: "monospace", fontSize: 10 }}>{data.code}</Text>
      </View>
    );
  }
  if (errors >= ERRORS_BEFORE_MUTE_CHIP) {
    return (
      <View style={{ backgroundColor: c.surface1, borderColor: c.surface2, borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 }}>
        <Text style={{ color: c.foregroundMuted, fontFamily: "monospace", fontSize: 10 }}>zw ? ({errors})</Text>
      </View>
    );
  }
  return null;
}
