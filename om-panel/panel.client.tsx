import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View, Pressable, ScrollView } from "react-native";
import { useRpc } from "@getpaseo/plugin";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin";
import { GetOmStateRpc, type OmPanelState } from "./rpc.js";

const POLL_MS = 30_000;

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.floor(s / 60)}m ago`;
  if (s < 129600) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const VIA_LABEL: Record<string, string> = {
  explicit: "đang chọn",
  agent: "agent của pill",
  "workspace-active": "agent active",
  newest: "mới nhất",
};

/**
 * v2: session-first. Header giữ mốc "session đang tracked" (active marker +
 * cách resolve), chip-switcher để nhảy sang session cũ, thân panel là danh
 * sách topic files của session đang chọn — mỗi file kèm size + freshness.
 */
export function OmPanel({ theme, workspaceId }: PluginWorkspacePanelProps) {
  const getState = useRpc(GetOmStateRpc);
  const [data, setData] = useState<OmPanelState | null>(null);
  const [picked, setPicked] = useState<string | null>(null); // override từ switcher
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getState({ workspaceId, sessionId: picked, indexLines: 10 }));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [getState, workspaceId, picked]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const c = theme.colors;
  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: c.surface0, padding: 12 },
      header: {
        backgroundColor: c.surface1,
        borderColor: c.border,
        borderWidth: 1,
        borderLeftColor: c.accent,
        borderLeftWidth: 3,
        borderRadius: 8,
        padding: 10,
        marginBottom: 10,
      },
      chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6, marginBottom: 10 },
      chip: {
        backgroundColor: c.surface2,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: 10,
        paddingVertical: 4,
      },
      chipActive: { borderColor: c.accent },
      card: { backgroundColor: c.surface1, borderRadius: 8, padding: 10, marginBottom: 10 },
      title: { color: c.foreground, fontSize: 13, fontWeight: "600" as const, marginBottom: 6 },
      row: { color: c.foreground, fontSize: 12, marginBottom: 2 },
      dim: { color: c.foregroundMuted, fontSize: 11, marginBottom: 2 },
      section: { color: c.foreground, fontSize: 12, fontWeight: "600" as const, marginTop: 8, marginBottom: 4 },
    }),
    [c],
  );

  const sel = data?.session;
  const resolved = data?.resolved;

  return (
    <ScrollView style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>
          {data?.workspace ?? workspaceId} · session{" "}
          {(resolved?.sessionId ?? "?").slice(0, 8)}
          {resolved && resolved.via !== "explicit" ? ` (${VIA_LABEL[resolved.via] ?? resolved.via})` : ""}
        </Text>
        {resolved?.agentTitle ? <Text style={styles.dim}>agent: {resolved.agentTitle}</Text> : null}
        {sel ? (
          <Text style={styles.dim}>
            {sel.topicFiles} topics · {sel.totalKb} KB · cập nhật {timeAgo(sel.lastModified)}
          </Text>
        ) : (
          <Text style={styles.dim}>{data?.note ?? "…"}</Text>
        )}
      </View>

      {data && data.sessions.length > 1 ? (
        <View style={styles.chips}>
          {data.sessions.map((s) => {
            const isSel = s.sessionId === (resolved?.sessionId ?? "");
            return (
              <Pressable
                key={s.sessionId}
                style={[styles.chip, isSel && styles.chipActive]}
                onPress={() => setPicked(isSel ? null : s.sessionId)}
              >
                <Text style={{ color: isSel ? c.accent : c.foregroundMuted, fontSize: 11 }}>
                  {s.active ? "● " : ""}
                  {s.title ? `${s.title.slice(0, 24)}` : s.sessionId.slice(0, 8)} · {s.topicFiles}t
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {error ? <Text style={styles.dim}>rpc error: {error}</Text> : null}

      {sel ? (
        <View style={styles.card}>
          <Text style={styles.section}>Topic files (mới nhất trước)</Text>
          {sel.topics.map((t) => (
            <View key={t.file} style={{ flexDirection: "row", marginBottom: 3, gap: 8 }}>
              <Text style={{ color: c.foreground, fontSize: 12, flexShrink: 1 }} numberOfLines={1}>
                {t.file}
              </Text>
              <Text style={{ color: c.foregroundMuted, fontSize: 11, marginLeft: "auto" }}>
                {t.kb} KB · {timeAgo(t.modified)}
              </Text>
            </View>
          ))}
          {sel.topics.length === 0 ? <Text style={styles.dim}>chưa có topic nào</Text> : null}

          {sel.indexHead.length > 0 ? (
            <>
              <Text style={styles.section}>INDEX.md</Text>
              {sel.indexHead.map((line, i) => (
                <Text key={i} style={styles.dim} numberOfLines={1}>
                  {line}
                </Text>
              ))}
            </>
          ) : null}
        </View>
      ) : null}

      {data ? (
        <Text style={styles.dim}>poll {POLL_MS / 1000}s · updated {timeAgo(data.generatedAt)}</Text>
      ) : null}
    </ScrollView>
  );
}
