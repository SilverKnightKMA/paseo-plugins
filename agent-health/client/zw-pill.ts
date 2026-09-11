import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { GetZwAlertRpc } from "../shared/rpc.js";

const POLL_MS = 2000;
/** After this many consecutive RPC failures the pill shows a muted "zw ?" label —
 *  a silent catch would make the pill vanish exactly when it is needed most
 *  (the 2026-09-05 "zombie without notification" report). */
const ERRORS_BEFORE_MUTE_LABEL = 3;

/**
 * Zombie-alert composer pill (0.8 button API). ZW is detect-only by design
 * (no kill API; auto-kick walks into the #3845 family), and since the v2
 * emission pivot its detections are silent in chat (jsonl + Agent Health
 * panel only). This pill restores visibility the model-invisible way: 2s
 * poll of the latest zombie-watchdog.jsonl entry; a fresh (< 5 min)
 * zombie/b2-settle-lost detection turns the pill ON with a STOP hint.
 * No alert → pill hidden (visible:false, registration kept — no flicker).
 */
export function startZwLive(client: PluginClientContext): () => void {
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
      id: `zw-pill-${key}`,
      workspaceId,
      agentId,
      button: {
        title: "ZW alert",
        icon: "Siren",
        label: "zw",
        visible: false,
        behavior: {
          kind: "action",
          onPress() {
            client.openPanel("agent-health", { workspaceId, agentId });
          },
        },
      },
    });
    registered.set(key, pill);
    let errors = 0;
    pollers.set(
      key,
      setInterval(() => {
        void client
          .rpc(GetZwAlertRpc, { agentId })
          .then((data) => {
            errors = 0;
            if (data.alert) {
              const who = data.agentId ? data.agentId.slice(0, 8) : "?";
              const label = data.mine ? "⚠ ZOMBIE — press STOP" : `zw ⚠ ${who}`;
              pill.update({ visible: true, label });
            } else {
              pill.update({ visible: false });
            }
          })
          .catch(() => {
            errors += 1;
            if (errors >= ERRORS_BEFORE_MUTE_LABEL) pill.update({ visible: true, label: `zw ? (${errors})` });
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
