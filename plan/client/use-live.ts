/**
 * use-live — shared client refresh strategy: event-push + slow backstop.
 *
 * SYNCED FILE: one byte-identical copy per plugin (task/, snip/, om-panel/,
 * om-status/) — check-shared-ui.py pins them; edit one, copy to the rest.
 *
 * Replaces the old blind 2s poll: panels subscribe to every agent the daemon
 * knows (via usePaseo().agents.ref(id).subscribe) and refetch debounced on
 * push. A slow backstop interval (default 15s) catches what push cannot:
 * newly created agents (no subscription yet) and dropped daemon events.
 */
import { useEffect } from "react";
import { usePaseo } from "@getpaseo/plugin/client";

export function useLiveRpc(refresh: () => void | Promise<void>, backstopMs = 15_000): void {
  const paseo = usePaseo();
  useEffect(() => {
    void refresh(); // first paint without waiting for a push or the backstop
    let deb: ReturnType<typeof setTimeout> | null = null;
    const disposers: Array<() => void> = [];
    const trigger = () => {
      if (deb) clearTimeout(deb);
      deb = setTimeout(() => void refresh(), 150); // coalesce a burst of pushes
    };
    let alive = true;
    void (async () => {
      try {
        const res = await paseo.agents.list();
        if (!alive) return;
        for (const e of res.entries) {
          const id = (e as { agent?: { id?: string } }).agent?.id;
          if (!id) continue;
          try {
            disposers.push(paseo.agents.ref(id).subscribe(() => trigger()));
          } catch {
            // one bad handle must not kill the others — backstop still covers it
          }
        }
      } catch {
        // agents metadata unavailable — run on backstop only (old degraded mode)
      }
    })();
    const timer = setInterval(() => void refresh(), backstopMs);
    return () => {
      alive = false;
      if (deb) clearTimeout(deb);
      clearInterval(timer);
      for (const d of disposers) {
        try {
          d();
        } catch {
          // already gone
        }
      }
    };
  }, [refresh, paseo, backstopMs]);
}
