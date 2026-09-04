import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View, Pressable, ScrollView } from "react-native";
import { useRpc } from "@getpaseo/plugin";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin";
import { GetOmStateRpc, type OmPanelState } from "./rpc.js";

function timeAgo(iso: string | null): string {
  if (!iso) {
    return "—";
  }
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

export function OmPanel({ theme, workspaceId }: PluginWorkspacePanelProps) {
  const getState = useRpc(GetOmStateRpc);
  const [data, setData] = useState<OmPanelState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setData(await getState({ indexLines: 8 }));
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
      card: { backgroundColor: theme.colors.surface1, borderRadius: 8, padding: 10, marginBottom: 10 },
      title: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const, marginBottom: 6 },
      row: { color: theme.colors.foreground, fontSize: 12, marginBottom: 2 },
      dim: { color: theme.colors.foregroundMuted, fontSize: 11, marginBottom: 2 },
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

  return (
    <ScrollView style={styles.screen}>
      <Pressable style={styles.button} onPress={() => void load()} disabled={busy}>
        <Text style={styles.buttonText}>{busy ? "Loading…" : "Rescan .memory"}</Text>
      </Pressable>

      {error ? <Text style={styles.dim}>rpc error: {error}</Text> : null}
      {!data && !error ? <Text style={styles.dim}>loading…</Text> : null}

      {data?.workspaces.map((ws) => (
        <View key={ws.workspace} style={styles.card}>
          <Text style={styles.title}>
            {ws.workspace} · {ws.sessions.length} session(s)
          </Text>
          {ws.sessions.map((s) => (
            <View key={s.sessionId}>
              <Text style={styles.row}>
                {s.topicFiles} topics · {s.totalKb} KB · {timeAgo(s.lastModified)}
              </Text>
              {s.indexHead.slice(0, 4).map((line, i) => (
                <Text key={i} style={styles.dim} numberOfLines={1}>
                  {"  "}
                  {line}
                </Text>
              ))}
            </View>
          ))}
        </View>
      ))}

      {data ? (
        <Text style={styles.dim}>
          workspace {workspaceId} · updated {timeAgo(data.generatedAt)}
        </Text>
      ) : null}
    </ScrollView>
  );
}
