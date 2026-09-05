import React, { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin";
import { GetOmStatusRpc } from "./rpc.js";
import { OmCard, OmHeader, OmSessionPicker, omChipLabel, omViaSuffix } from "./ui.js";

const POLL_MS = 2000;

export function OmStatusPanel(props: PluginWorkspacePanelProps) {
  const read = useRpc(GetOmStatusRpc);
  const [data, setData] = useState<Awaited<ReturnType<typeof read>> | null>(null);
  const [picked, setPicked] = useState<string | null>(null); // chips override

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
  return (
    <View style={{ padding: 12, gap: 8, backgroundColor: c.surface0 }}>
      {data == null ? (
        <Text style={{ color: c.foregroundMuted }}>loading…</Text>
      ) : !data.present ? (
        <OmCard c={c} noRail>
          <Text style={{ fontSize: 13, color: c.foreground }}>OM chưa chạy trong workspace này</Text>
          <Text style={{ fontSize: 12, color: c.foregroundMuted, marginTop: 4 }}>
            {data.note ?? "/om on trong session để bật observational-memory — panel này sẽ tự cập nhật."}
          </Text>
        </OmCard>
      ) : (
        <>
          <OmHeader
            c={c}
            rail={stale ? c.statusWarning : c.accent}
            title={`${data.workspace ?? props.workspaceId} · session ${(data.resolved?.sessionId ?? "?").slice(0, 8)}${omViaSuffix(data.resolved?.via)}`}
            dim={[
              ...(data.resolved?.agentTitle ? [`agent: ${data.resolved.agentTitle}`] : []),
              ...(data.summary
                ? [
                    `${data.summary.verdict} · ctx ${
                      data.summary.contextTokens != null
                        ? Math.round((data.summary.contextTokens / data.summary.contextMax) * 100)
                        : "?"
                    }% · $${data.summary.sessionCostUsd.toFixed(2)}`,
                  ]
                : []),
              `live · cập nhật ${data.ageSec ?? "?"}s trước · poll ${POLL_MS / 1000}s`,
            ]}
          />
          <OmSessionPicker
            c={c}
            sessions={sessions.map((s) => ({
              sessionId: s.sessionId,
              label: omChipLabel(s.active, s.title, s.sessionId, s.topicFiles),
              active: s.active,
            }))}
            selectedId={data.resolved?.sessionId}
            onPick={(id) => setPicked(id)}
          />
          <OmCard c={c} rail={stale ? c.statusWarning : c.accent}>
            {data.lines.map((line, i) => {
              if (!line.trim()) return <View key={i} style={{ height: 6 }} />;
              if (line.startsWith("om status — ")) {
                return (
                  <Text key={i} style={{ color: c.foreground, fontSize: 12, fontWeight: "600" as const, marginBottom: 2 }}>
                    {line.slice("om status — ".length)}
                  </Text>
                );
              }
              const sub = line.startsWith("    ");
              const t = line.trim();
              const sep = t.indexOf(": ");
              if (!sub && !line.startsWith("  ") && sep < 0) {
                return (
                  <Text key={i} style={{ color: c.foregroundMuted, fontSize: 11, fontWeight: "600" as const, marginTop: 4, marginBottom: 2 }}>
                    {t}
                  </Text>
                );
              }
              const label = sep > 0 ? `${t.slice(0, sep + 1)}` : null;
              const value = sep > 0 ? t.slice(sep + 2) : t;
              return (
                <View key={i} style={{ flexDirection: "row" as const, paddingLeft: sub ? 30 : 8, marginBottom: 1, gap: 6 }}>
                  {label ? (
                    <Text style={{ color: c.foregroundMuted, fontSize: 11, fontFamily: "monospace", minWidth: 100 }}>{label}</Text>
                  ) : null}
                  <Text style={{ color: c.foreground, fontSize: 11, fontFamily: "monospace", flexShrink: 1 }}>{value}</Text>
                </View>
              );
            })}
            <Text style={{ fontSize: 11, color: c.foregroundMuted, marginTop: 6 }}>
              {stale ? "⚠ không có event mới" : "live"}
            </Text>
          </OmCard>

          <Text style={{ fontSize: 12, fontWeight: "600" as const, color: c.foreground }}>
            Sự kiện gần đây (mới nhất trước)
          </Text>
          {data.events.map((e, i) => (
            <Text key={i} style={{ fontSize: 12, color: c.foregroundMuted }}>
              {e.ts.slice(11, 19)} · {e.text.split("\n")[0]}
            </Text>
          ))}
        </>
      )}
    </View>
  );
}
