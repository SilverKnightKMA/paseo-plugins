import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { GetTaskStateRpc } from "../shared/rpc.js";

const POLL_MS = 2000;

/**
 * Composer pill (0.8 button API). Pills target one (workspaceId, agentId) —
 * enumerate agents and register one pill per pair; subscribe + 30s diff
 * covers new chats. The 2s poll lives here (no Component anymore) and pushes
 * label changes through registration.update().
 */
export function startTaskLive(client: PluginClientContext): () => void {
  const registered = new Map<string, PluginButtonRegistration>();
  const pollers = new Map<string, ReturnType<typeof setInterval>>();

  function drop(key: string): void {
    clearInterval(pollers.get(key));
    pollers.delete(key);
    registered.get(key)?.remove();
    registered.delete(key);
  }

  function register(workspaceId: string, agentId: string): void {
    const key = `${workspaceId}/${agentId}`;
    if (registered.has(key)) return;
    let pill: PluginButtonRegistration;
    try {
      pill = client.addComposerPill({
      id: `task-pill-${key}`,
      workspaceId,
      agentId,
      button: {
        title: "Tasks",
        icon: "ListTodo",
        label: "task –",
        behavior: {
          kind: "action",
          onPress() {
            client.openPanel("task", { workspaceId, agentId });
          },
        },
      },
    });
    } catch (err) {
      // #244 (v1.0.94): silent registration death is now visible (spec-244 M1).
      console.error("[pill:task] register failed", { workspaceId, agentId, err });
      return;
    }
    registered.set(key, pill);
    pollers.set(
      key,
      setInterval(() => {
        void client
          .rpc(GetTaskStateRpc, { workspaceId, agentId })
          .then((next) => {
            pill.update({ label: next.engineLive && next.total > 0 ? `task ${next.done}/${next.total}` : "task –" });
          })
          .catch(() => {
            // RPC hiccup — keep last label
          });
      }, POLL_MS),
    );
  }

  async function sync(): Promise<void> {
    try {
      const res = await client.paseo.agents.list();
      const seen = new Set<string>();
      const agents = (res.entries as unknown[])
        .map((e) => (e as { agent?: { id?: string; workspaceId?: string | null } }).agent)
        .filter((a): a is { id: string; workspaceId: string } => Boolean(a?.id && a?.workspaceId));
      for (const agent of agents) {
        const { workspaceId, id: agentId } = agent;
        seen.add(`${workspaceId}/${agentId}`);
        register(workspaceId, agentId);
      }
      for (const key of [...registered.keys()]) {
        if (!seen.has(key)) drop(key);
      }
      // #244: outcome visibility — see spec-244 M1/M2.
      if (registered.size !== lastCount) {
        lastCount = registered.size;
        console.info(`[pill:task] registered=${lastCount}`);
      }
    } catch (err) {
      // #244: name the failure — silent catches hid every pill death.
      console.error("[pill:task] agents.list failed:", err);
    }
  }
  let lastCount = -1;

  void sync();
  const unsub = client.paseo.agents.subscribe(() => void sync());
  const timer = setInterval(() => void sync(), 30_000);
  return () => {
    unsub();
    clearInterval(timer);
    for (const key of [...registered.keys()]) drop(key);
  };
}
