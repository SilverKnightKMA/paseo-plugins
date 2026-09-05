import React, { useCallback, useEffect, useState } from "react";
import { Text, View, Pressable, TextInput } from "react-native";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin";
import { GetOmStatusRpc } from "./rpc.js";

const POLL_MS = 2000;

const SHOW_RECENT = 4; // số chip hiển thị — flood control, phần còn lại sau search

export function OmStatusPanel(props: PluginWorkspacePanelProps) {
  const read = useRpc(GetOmStatusRpc);
  const [data, setData] = useState<Awaited<ReturnType<typeof read>> | null>(null);
  const [picked, setPicked] = useState<string | null>(null); // chips override
  const [expanded, setExpanded] = useState(false); // hiện hết chips hay chỉ SHOW_RECENT
  const [search, setSearch] = useState("");

  const refresh = useCallback(async () => {
    try {
      const next = await read({ workspaceId: props.workspaceId, sessionId: picked });
      setData(next);
    } catch {
      // RPC hiccup — keep the last snapshot, next poll retries
    }
  }, [props.workspaceId, picked, read]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const stale = data != null && data.present && (data.ageSec ?? 999) > 120;
  const c = props.theme.colors;
  const sessions = data?.sessions ?? [];
  const q = search.trim().toLowerCase();
  const filtered = q
    ? sessions.filter((s) => s.sessionId.toLowerCase().includes(q) || (s.title ?? "").toLowerCase().includes(q))
    : sessions;
  const chips = q || expanded ? filtered : filtered.slice(0, SHOW_RECENT);
  const hidden = q || expanded ? 0 : filtered.length - chips.length;
  const label = (s: { sessionId: string; title: string | null }): string =>
    s.title ? `${s.title.slice(0, 24)}` : s.sessionId.slice(0, 8);

  return (
    <View style={{ padding: 12, gap: 8 }}>
      {data == null ? (
        <Text style={{ color: props.theme.colors.foregroundMuted }}>loading…</Text>
      ) : !data.present ? (
        <View style={{ backgroundColor: c.surface1, borderRadius: 6, padding: 10 }}>
          <Text style={{ fontSize: 13, color: c.foreground }}>OM chưa chạy trong workspace này</Text>
          <Text style={{ fontSize: 12, color: c.foregroundMuted, marginTop: 4 }}>
            {data.note ?? "/om on trong session để bật observational-memory — panel này sẽ tự cập nhật."}
          </Text>
        </View>
      ) : (
        <>
          <View
            style={{
              backgroundColor: c.surface1,
              borderRadius: 6,
              padding: 10,
              flexDirection: "row",
              justifyContent: "space-between",
            }}
          >
            <Text style={{ fontSize: 11, color: c.foregroundMuted, flex: 1 }} numberOfLines={1}>
              {data.resolved?.agentTitle ? `${data.resolved.agentTitle.slice(0, 30)} · ` : ""}
              {data.resolved?.via === "explicit" ? "đang chọn" : data.resolved?.via === "agent" ? "agent active" : ""}
              {data.resolved && data.resolved.via !== "explicit" ? ` · ${(data.resolved.sessionId ?? "?").slice(0, 8)}` : ""}
            </Text>
            <Text style={{ fontSize: 11, color: c.foregroundMuted }}>
              {data.sessions.length > 1 ? `${data.sessions.length} sessions` : ""}
            </Text>
          </View>
          {sessions.length > 1 ? (
            <View style={{ marginBottom: 8, gap: 6 }}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                {chips.map((s) => {
                  const isSel = data?.resolved?.sessionId === s.sessionId;
                  return (
                    <Pressable
                      key={s.sessionId}
                      onPress={() => setPicked(isSel ? null : s.sessionId)}
                      style={{
                        backgroundColor: isSel ? c.surface2 : c.surface1,
                        borderColor: isSel ? c.accent : c.border,
                        borderWidth: 1,
                        borderRadius: 999,
                        paddingHorizontal: 10,
                        paddingVertical: 4,
                      }}
                    >
                      <Text style={{ color: isSel ? c.accent : c.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
                        {label(s)}
                      </Text>
                    </Pressable>
                  );
                })}
                {hidden > 0 ? (
                  <Pressable
                    onPress={() => setExpanded(true)}
                    style={{ backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}
                  >
                    <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>+{hidden} nữa…</Text>
                  </Pressable>
                ) : expanded ? (
                  <Pressable
                    onPress={() => setExpanded(false)}
                    style={{ backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}
                  >
                    <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>thu gọn</Text>
                  </Pressable>
                ) : null}
              </View>
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="tìm session theo tên / id…"
                placeholderTextColor={c.foregroundMuted}
                style={{
                  backgroundColor: c.surface1,
                  borderColor: c.border,
                  borderWidth: 1,
                  borderRadius: 6,
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  color: c.foreground,
                  fontSize: 12,
                }}
              />
            </View>
          ) : null}
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
