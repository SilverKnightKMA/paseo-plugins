import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { GetOmStatusRpc } from "../shared/rpc.js";

// #39: labels refresh on daemon push (agent events — bell appends included)
// with a 150ms debounce; this slow backstop only catches dropped events.
const BACKSTOP_MS = 15_000;
const DEBOUNCE_MS = 150;

/** Verdict glyph for the pill label (text-only — 0.8 pills have no styling). */
function verdictMark(verdict: string): string {
  if (verdict === "healthy") return "✓";
  if (verdict === "warning") return "!";
  return "…";
}

/** Collapse an OmStatusState into the pill label text. */
async function fetchOm(client: PluginClientContext, workspaceId: string, agentId: string) {
  const data = await client.rpc(GetOmStatusRpc, { workspaceId, agentId });
  if (!data?.present || !data.summary) return data?.present ? "om …" : "om off";
  const s = data.summary;
  const ctx = s.contextTokens != null ? `ctx ${Math.round((s.contextTokens / s.contextMax) * 100)}%` : "ctx ?";
  const workers = s.verdict === "working" ? (s.observersRunning > 0 ? `${s.observersRunning}/${s.observerSlots}` : "c") : "✓";
  return `om ${verdictMark(s.verdict)} ${workers} ${ctx} $${s.sessionCostUsd.toFixed(2)} · ${s.sessionRuns}r`;
}

/**
 * Composer pill (0.8 button API). Pills target one (workspaceId, agentId) —
 * enumerate agents via client.paseo.agents.list() and register one pill per
 * pair; agents.subscribe + a 30s diff covers new chats. The 2s poll lives
 * here (no Component anymore) and pushes label changes through
 * registration.update().
 */
export function startOmLive(client: PluginClientContext): () => void {
  const registered = new Map<string, PluginButtonRegistration>();
  const unsubscribers = new Map<string, () => void>();
  const debounces = new Map<string, ReturnType<typeof setTimeout>>();

  function drop(key: string): void {
    const deb = debounces.get(key);
    if (deb) clearTimeout(deb);
    debounces.delete(key);
    try {
      unsubscribers.get(key)?.();
    } catch {
      // already gone
    }
    unsubscribers.delete(key);
    registered.get(key)?.remove();
    registered.delete(key);
  }

  /** Push-driven label refresh: debounce a burst of agent events, then refetch. */
  function schedule(key: string): void {
    const prev = debounces.get(key);
    if (prev) clearTimeout(prev);
    debounces.set(key, setTimeout(() => {
      debounces.delete(key);
      const pill = registered.get(key);
      if (!pill) return;
      const [workspaceId, agentId] = key.split("/");
      void fetchOm(client, workspaceId, agentId)
        .then((label) => pill.update({ label }))
        .catch(() => {
          // keep last label; backstop retries
        });
    }, DEBOUNCE_MS));
  }

  function register(workspaceId: string, agentId: string): void {
    const key = `${workspaceId}/${agentId}`;
    if (registered.has(key)) return;
    const pill = client.addComposerPill({
      id: `om-status-pill-${key}`,
      workspaceId,
      agentId,
      button: {
        title: "OM",
        icon: "Brain",
        label: "om …",
        behavior: {
          kind: "action",
          onPress() {
            client.openPanel("om-status", { workspaceId, agentId });
          },
        },
      },
    });
    registered.set(key, pill);
    try {
      unsubscribers.set(key, client.paseo.agents.ref(agentId).subscribe(() => schedule(key)));
    } catch {
      // no handle — the backstop below still refreshes this pill
    }
  }

  async function sync(): Promise<void> {
    try {
      const res = await client.paseo.agents.list();
      const seen = new Set<string>();
      // wire entries are { agent: <snapshot> } wrappers — unwrap
      const agents = res.entries
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
  const syncTimer = setInterval(() => void sync(), 30_000); // new/removed chats
  // backstop: refresh every label even if a push was dropped (was a 2s poll)
  const backstop = setInterval(() => {
    for (const key of registered.keys()) schedule(key);
  }, BACKSTOP_MS);
  return () => {
    unsub();
    clearInterval(syncTimer);
    clearInterval(backstop);
    for (const key of [...registered.keys()]) drop(key);
  };
}
