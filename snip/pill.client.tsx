import { useEffect, useRef, useState } from "react";
import { Text } from "react-native";
import { useRpc, type PluginClientContext, type PluginComposerPillProps } from "@getpaseo/plugin";
import { GetSnipStateRpc } from "./rpc.js";

const POLL_MS = 2000;

/**
 * ComposerPill registration. Pills match STRICTLY by (workspaceId, agentId) —
 * no wildcards — so enumerate agents via client.paseo.agents.list() and
 * register one pill per pair; subscribe + 30s diff covers new chats
 * (mirrors om-status live.client.tsx).
 */
export function startSnipLive(client: PluginClientContext): () => void {
  const cleanups: Array<() => void> = [];
  const registered = new Map<string, () => void>();

  async function sync(): Promise<void> {
    try {
      const res = await client.paseo.agents.list();
      const seen = new Set<string>();
      // wire entries are { agent: <snapshot> } wrappers — unwrap
      const agents = (res.entries as unknown[])
        .map((e) => (e as { agent?: { id?: string; workspaceId?: string | null } }).agent)
        .filter((a): a is { id: string; workspaceId: string } => Boolean(a?.id && a?.workspaceId));
      for (const agent of agents) {
        const { workspaceId, id: agentId } = agent;
        const key = `${workspaceId}/${agentId}`;
        seen.add(key);
        if (registered.has(key)) continue;
        const cleanup = client.addComposerPill({
          id: `snip-pill-${key}`,
          title: "Snip",
          workspaceId,
          agentId,
          Component: SnipPill,
          onPress: () => {
            void client.openPanel("snip", { workspaceId, agentId });
          },
        });
        registered.set(key, cleanup);
        cleanups.push(cleanup);
      }
      // release pills whose agents disappeared
      for (const key of [...registered.keys()]) {
        if (!seen.has(key)) {
          registered.get(key)?.();
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
    for (const cleanup of cleanups) cleanup();
  };
}

/** Pill body: `snip 2` / `snip ·s` when armed, `snip –` when idle. */
export function SnipPill(props: PluginComposerPillProps) {
  const read = useRpc(GetSnipStateRpc);
  const [armed, setArmed] = useState<{ active: string[]; sticky: boolean; live: boolean }>({ active: [], sticky: false, live: false });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const refresh = async () => {
      try {
        const next = await read({ workspaceId: props.workspaceId, agentId: props.agentId });
        if (!mounted.current) return;
        setArmed({ active: next.active, sticky: next.sticky, live: next.engineLive });
      } catch {
        // RPC hiccup — keep last snapshot
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [props.workspaceId, props.agentId, read]);

  const label = armed.active.length > 0 ? `snip ${armed.active.length}${armed.sticky ? " ·s" : ""}` : "snip –";
  return (
    <Text style={{ fontSize: 11, opacity: armed.active.length > 0 ? 1 : 0.6 }}>{label}</Text>
  );
}
