import { useEffect, useRef, useState } from "react";
import { Text } from "react-native";
import { useRpc, type PluginClientContext, type PluginComposerPillProps } from "@getpaseo/plugin";
import { GetTaskStateRpc } from "./rpc.js";

const POLL_MS = 2000;

/**
 * ComposerPill registration. Pills match STRICTLY by (workspaceId, agentId) —
 * no wildcards — so enumerate agents via client.paseo.agents.list() and
 * register one pill per pair; subscribe + 30s diff covers new chats
 * (mirrors snip/om-status pills; sits in the same row as the agent badge).
 */
export function startTaskLive(client: PluginClientContext): () => void {
  const cleanups: Array<() => void> = [];
  const registered = new Map<string, () => void>();

  async function sync(): Promise<void> {
    try {
      const res = await client.paseo.agents.list();
      const seen = new Set<string>();
      const agents = (res.entries as unknown[])
        .map((e) => (e as { agent?: { id?: string; workspaceId?: string | null } }).agent)
        .filter((a): a is { id: string; workspaceId: string } => Boolean(a?.id && a?.workspaceId));
      for (const agent of agents) {
        const { workspaceId, id: agentId } = agent;
        const key = `${workspaceId}/${agentId}`;
        seen.add(key);
        if (registered.has(key)) continue;
        const cleanup = client.addComposerPill({
          id: `task-pill-${key}`,
          title: "Tasks",
          workspaceId,
          agentId,
          Component: TaskPill,
          onPress: () => {
            void client.openPanel("task", { workspaceId, agentId });
          },
        });
        registered.set(key, cleanup);
        cleanups.push(cleanup);
      }
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

/** Pill body: `task 2/5` when the engine is live, `task –` when idle. */
export function TaskPill(props: PluginComposerPillProps) {
  const read = useRpc(GetTaskStateRpc);
  const [gauge, setGauge] = useState<{ done: number; total: number; live: boolean }>({ done: 0, total: 0, live: false });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const refresh = async () => {
      try {
        const next = await read({ workspaceId: props.workspaceId, agentId: props.agentId });
        if (!mounted.current) return;
        setGauge({ done: next.done, total: next.total, live: next.engineLive });
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

  const label = gauge.live && gauge.total > 0 ? `task ${gauge.done}/${gauge.total}` : "task –";
  const allDone = gauge.total > 0 && gauge.done === gauge.total;
  return (
    <Text style={{ fontSize: 11, opacity: gauge.live && gauge.total > 0 ? (allDone ? 0.85 : 1) : 0.6 }}>{label}</Text>
  );
}
