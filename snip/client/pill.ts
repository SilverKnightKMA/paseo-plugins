import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { GetSnipStateRpc } from "../shared/rpc.js";

const POLL_MS = 2000;

/**
 * Composer pill (0.8 button API). Pills target one (workspaceId, agentId) —
 * enumerate agents via client.paseo.agents.list() and register one pill per
 * pair; agents.subscribe + a 30s diff covers new chats. The old pill polled
 * from inside a Component; 0.8 pills have no Component, so the 2s poll lives
 * here and pushes label changes through registration.update().
 */
export function startSnipLive(client: PluginClientContext): () => void {
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
    const pill = client.addComposerPill({
      id: `snip-pill-${key}`,
      workspaceId,
      agentId,
      button: {
        title: "Snip",
        icon: "MessageSquare",
        label: "snip –",
        behavior: {
          kind: "action",
          onPress() {
            client.openPanel("snip", { workspaceId, agentId });
          },
        },
      },
    });
    registered.set(key, pill);
    pollers.set(
      key,
      setInterval(() => {
        void client
          .rpc(GetSnipStateRpc, { workspaceId, agentId })
          .then((next) => {
            pill.update({
              label: next.active.length > 0 ? `snip ${next.active.length}${next.sticky ? " ·s" : ""}` : "snip –",
            });
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
      // wire entries are { agent: <snapshot> } wrappers — unwrap
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
    for (const key of [...registered.keys()]) drop(key);
  };
}
