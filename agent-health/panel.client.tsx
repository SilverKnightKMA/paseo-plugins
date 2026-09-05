import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View, ScrollView } from "react-native";
import { useRpc } from "@getpaseo/plugin";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin";
import { GetStateRpc, type AgentHealthState } from "./rpc.js";

function shortCwd(cwd: string): string {
  if (!cwd) {
    return "(no cwd)";
  }
  return cwd.replace("/home/coder/workspaces/", "~/").replace("/home/coder", "~");
}

/** Panel poll interval — matches om-status/om-panel live panels. */
const POLL_MS = 2000;

function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) {
    return iso;
  }
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.floor(s / 60)}m ago`;
  if (s < 129600) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function HealthPanel({ theme, workspaceId }: PluginWorkspacePanelProps) {
  const getState = useRpc(GetStateRpc);
  const [data, setData] = useState<AgentHealthState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasDataRef = useRef(false);

  const load = useCallback(async () => {
    // Best-effort poll: errors keep the last good snapshot on screen.
    setError(null);
    try {
      const result = await getState({ limit: 20 });
      setData(result);
      hasDataRef.current = true;
    } catch (err) {
      setError(String(err));
    }
  }, [getState]);

  useEffect(() => {
    void load();
    // Auto-refresh like om-status/om-panel: the panel is a live monitor, not a
    // load-once snapshot (user request 2026-09-05 — "auto-refresh like OM").
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0, padding: 12 },
      card: {
        backgroundColor: theme.colors.surface1,
        borderRadius: 8,
        padding: 10,
        marginBottom: 10,
      },
      title: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const, marginBottom: 6 },
      row: { color: theme.colors.foreground, fontSize: 12, marginBottom: 2 },
      dim: { color: theme.colors.foregroundMuted, fontSize: 11, marginBottom: 2 },
      accentText: { color: theme.colors.statusWarning, fontSize: 11, marginBottom: 2 },
    }),
    [theme],
  );

  const running = data?.agents.filter((a) => a.status === "running") ?? [];

  // Fresh (< 5 min) zombie/b2 detection → loud banner at the top, so a zombie is
  // visible the moment the panel is opened even if the composer pill was missed.
  const lastZw = data?.zwEvents[data.zwEvents.length - 1] ?? null;
  const zwAlertCode =
    lastZw && (lastZw.code === "zombie" || lastZw.code === "b2-settle-lost") ? lastZw.code : null;
  const zwAlertAge = lastZw ? Date.now() - Date.parse(lastZw.ts) : null;
  const zwAlertFresh =
    zwAlertCode !== null && zwAlertAge !== null && zwAlertAge >= 0 && zwAlertAge < 5 * 60_000;

  return (
    <ScrollView style={styles.screen}>
      {zwAlertFresh && lastZw ? (
        <View style={{ backgroundColor: theme.colors.statusDanger + "22", borderColor: theme.colors.statusDanger, borderWidth: 1, borderRadius: 8, padding: 8, marginBottom: 8 }}>
          <Text style={{ color: theme.colors.statusDanger, fontSize: 13, fontWeight: "700" as const }}>
            ⚠ ZOMBIE DETECTED — {zwAlertCode} ({timeAgo(lastZw.ts)})
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
            {lastZw.agentId ? `agent ${lastZw.agentId.slice(0, 8)}` : "agent unknown"} · press STOP on that agent (if it is you)
          </Text>
        </View>
      ) : null}
      <Text style={styles.dim}>live · auto-refresh {POLL_MS / 1000}s · updated {data ? timeAgo(data.generatedAt) : "…"}</Text>

      {error ? <Text style={styles.accentText}>rpc error: {error}</Text> : null}
      {!data && !error ? <Text style={styles.dim}>loading…</Text> : null}

      {data ? (
        <>
          <View style={styles.card}>
            <Text style={styles.title}>Agents ({data.agents.length}) — {running.length} running</Text>
            {data.agents.map((a) => (
              <Text key={a.id} style={a.status === "running" ? styles.row : styles.dim}>
                {a.status ?? "?"} · {a.provider}{a.model ? `/${a.model}` : ""} · {shortCwd(a.cwd)}
              </Text>
            ))}
          </View>

          <View style={styles.card}>
            <Text style={styles.title}>Zombie-watchdog (all-time)</Text>
            {Object.keys(data.zwCounts).length === 0 ? (
              <Text style={styles.dim}>no events recorded</Text>
            ) : (
              Object.entries(data.zwCounts).map(([code, n]) => (
                <Text key={code} style={n > 0 ? styles.accentText : styles.dim}>
                  {code}: {n}
                </Text>
              ))
            )}
          </View>

          <View style={styles.card}>
            <Text style={styles.title}>Recent zw events</Text>
            {data.zwEvents.length === 0 ? (
              <Text style={styles.dim}>none</Text>
            ) : (
              [...data.zwEvents].reverse().map((e, i) => (
                <Text key={`${e.ts}-${i}`} style={styles.dim}>
                  {timeAgo(e.ts)} · {e.code}
                  {e.idleMs !== null ? ` · idle ${(e.idleMs / 1000).toFixed(0)}s` : ""}
                </Text>
              ))
            )}
          </View>

          <View style={styles.card}>
            <Text style={styles.title}>Stuck queues ({data.stuckQueues.length})</Text>
            {data.stuckQueues.length === 0 ? (
              <Text style={styles.dim}>no undelivered messages older than 48h</Text>
            ) : (
              data.stuckQueues.map((q) => (
                <Text key={q.agentId} style={styles.accentText}>
                  {q.name ?? q.agentId.slice(0, 8)} · {q.events} msg · {q.ageHours}h old
                </Text>
              ))
            )}
          </View>

          <Text style={styles.dim}>
            workspace {workspaceId} · updated {timeAgo(data.generatedAt)}
          </Text>
        </>
      ) : null}
    </ScrollView>
  );
}
