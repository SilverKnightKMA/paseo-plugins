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
    let pill: PluginButtonRegistration;
    try {
      pill = client.addComposerPill({
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
    } catch (err) {
      // #244 (v1.0.94): registration failures were silent — the pill just
      // never appeared and nothing said why. Log with the ids so the M2
      // contingency table in spec-244 can act on it.
      console.error("[pill:snip] register failed", { workspaceId, agentId, err });
      return;
    }
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
      // #244: make the outcome visible — registered=0 with no error means the
      // app-side filter rejected the ids (M2 branch 3), not a silent death.
      if (registered.size !== lastCount) {
        lastCount = registered.size;
        console.info(`[pill:snip] registered=${lastCount}`);
      }
    } catch (err) {
      // #244: daemon offline / RPC hiccup used to be a silent catch — now it
      // names the failure so "no pills ever" is diagnosable in devtools.
      console.error("[pill:snip] agents.list failed:", err);
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
