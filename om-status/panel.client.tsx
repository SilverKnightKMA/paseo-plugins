import React, { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin";
import { GetOmStatusRpc } from "./rpc.js";

const POLL_MS = 2000;

export function OmStatusPanel(props: PluginWorkspacePanelProps) {
  const read = useRpc(GetOmStatusRpc);
  const [data, setData] = useState<Awaited<ReturnType<typeof read>> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await read({ workspaceId: props.workspaceId });
      setData(next);
    } catch {
      // RPC hiccup — keep the last snapshot, next poll retries
    }
  }, [props.workspaceId, read]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const stale = data != null && data.present && (data.ageSec ?? 999) > 120;

  return (
    <View style={{ padding: 12, gap: 8 }}>
      {data == null ? (
        <Text style={{ color: props.theme.colors.foregroundMuted }}>loading…</Text>
      ) : !data.present ? (
        <View style={{ backgroundColor: props.theme.colors.surface1, borderRadius: 6, padding: 10 }}>
          <Text style={{ fontSize: 13, color: props.theme.colors.foreground }}>
            OM chưa chạy trong workspace này
          </Text>
          <Text style={{ fontSize: 12, color: props.theme.colors.foregroundMuted, marginTop: 4 }}>
            {data.note ?? "/om on trong session để bật observational-memory — panel này sẽ tự cập nhật."}
          </Text>
        </View>
      ) : (
        <>
          <View
            style={{
              backgroundColor: props.theme.colors.surface1,
              borderRadius: 6,
              padding: 10,
              flexDirection: "row",
              justifyContent: "space-between",
            }}
          >
            <Text style={{ fontSize: 11, color: props.theme.colors.foregroundMuted }}>
              session {(data.sessionId ?? "?").slice(0, 8)}
              {data.resolved?.via === "workspace-active" ? " · agent active" : ""}
            </Text>
            <Text style={{ fontSize: 11, color: props.theme.colors.foregroundMuted }}>
              {data.sessions.length > 1 ? `${data.sessions.length} sessions có file` : ""}
            </Text>
          </View>
          <View
            style={{
              backgroundColor: props.theme.colors.surface1,
              borderLeftWidth: 3,
              borderLeftColor: stale ? props.theme.colors.statusWarning : props.theme.colors.accent,
              borderRadius: 6,
              padding: 10,
            }}
          >
            {data.lines.map((line, i) => (
              <Text
                key={i}
                style={{
                  fontSize: 12,
                  fontFamily: "monospace",
                  color: line.trim().length === 0 ? "transparent" : props.theme.colors.foreground,
                }}
              >
                {line.length === 0 ? " " : line}
              </Text>
            ))}
            <Text style={{ fontSize: 11, color: props.theme.colors.foregroundMuted, marginTop: 6 }}>
              {stale ? "⚠ không có event mới" : "live"} · cập nhật {data.ageSec ?? "?"}s trước · poll {POLL_MS / 1000}s
              {data.sessionId ? ` · session ${data.sessionId.slice(0, 8)}` : ""}
            </Text>
          </View>

          <Text style={{ fontSize: 12, fontWeight: "600" as const, color: props.theme.colors.foreground }}>
            Sự kiện gần đây (mới nhất trước)
          </Text>
          {data.events.map((e, i) => (
            <Text key={i} style={{ fontSize: 12, color: props.theme.colors.foregroundMuted }}>
              {e.ts.slice(11, 19)} · {e.text.split("\n")[0]}
            </Text>
          ))}
        </>
      )}
    </View>
  );
}
