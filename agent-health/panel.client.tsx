import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View, Pressable, ScrollView } from "react-native";
import { useRpc } from "@getpaseo/plugin";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin";
import { GetStateRpc, type AgentHealthState } from "./rpc.js";

function shortCwd(cwd: string): string {
  if (!cwd) {
    return "(no cwd)";
  }
  return cwd.replace("/home/coder/workspaces/", "~/").replace("/home/coder", "~");
}

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
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await getState({ limit: 20 });
      setData(result);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [getState]);

  useEffect(() => {
    void load();
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
      button: {
        backgroundColor: theme.colors.accent,
        borderRadius: 6,
        paddingVertical: 8,
        paddingHorizontal: 12,
        alignItems: "center" as const,
        marginBottom: 10,
      },
      buttonText: { color: theme.colors.accentForeground, fontSize: 12, fontWeight: "600" as const },
    }),
    [theme],
  );

  const running = data?.agents.filter((a) => a.status === "running") ?? [];

  return (
    <ScrollView style={styles.screen}>
      <Pressable style={styles.button} onPress={() => void load()} disabled={busy}>
        <Text style={styles.buttonText}>{busy ? "Loading…" : "Refresh"}</Text>
      </Pressable>

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

          <Text style={styles.dim}>
            workspace {workspaceId} · updated {timeAgo(data.generatedAt)}
          </Text>
        </>
      ) : null}
    </ScrollView>
  );
}
