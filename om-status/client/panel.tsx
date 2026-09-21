import React, { useCallback, useState } from "react";
import { Text, View, ScrollView } from "react-native";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { GetOmStatusRpc } from "../shared/rpc.js";
import { OmCard, OmHeader, OmSection, OmSessionPicker, omChipLabel, omViaSuffix, type OmColors } from "./ui.js";
import { useLiveRpc } from "./use-live.js";

const BACKSTOP_MS = 15_000; // push-driven refresh; backstop catches new agents + dropped events

function OmKV({ c, label, value }: { c: OmColors; label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row" as const, gap: 6, marginBottom: 1 }}>
      <Text style={{ color: c.foregroundMuted, fontSize: 11, fontFamily: "monospace", minWidth: 110 }}>{label}</Text>
      <Text style={{ color: c.foreground, fontSize: 11, fontFamily: "monospace", flexShrink: 1 }}>{value}</Text>
    </View>
  );
}

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

  useLiveRpc(refresh, BACKSTOP_MS);

  const stale = data != null && data.present && (data.ageSec ?? 999) > 120;
  const c = props.theme.colors;
  const sessions = data?.sessions ?? [];
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: 12, gap: 8 }}>
      {data == null ? (
        <Text style={{ color: c.foregroundMuted }}>loading…</Text>
      ) : !data.present ? (
        <OmCard c={c} noRail>
          <Text style={{ fontSize: 13, color: c.foreground }}>
            OM not active for session {(data.resolved?.sessionId ?? "?").slice(0, 8)}
            {data.resolved?.via ? omViaSuffix(data.resolved.via) : ""}
          </Text>
          <Text style={{ fontSize: 12, color: c.foregroundMuted, marginTop: 4 }}>
            {data.note ?? "/om on in the session to enable observational-memory — this panel will update itself."}
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
              `live · updated ${data.ageSec ?? "?"}s ago · live-push + ${BACKSTOP_MS / 1000}s backstop`,
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
            {stale ? (
              <Text style={{ fontSize: 11, color: c.statusWarning, marginTop: 6 }}>⚠ no new events for {data.ageSec ?? "?"}s</Text>
            ) : null}
          </OmCard>

          <OmCard c={c} noRail>
            <OmSection c={c}>Cost & storage</OmSection>
            {data.summary ? (
              <>
                <OmKV c={c} label="session:" value={`$${data.summary.sessionCostUsd.toFixed(4)} (${data.summary.sessionRuns} runs)`} />
                <OmKV
                  c={c}
                  label="  observer:"
                  value={`$${data.summary.observerCostUsd.toFixed(4)} (${data.summary.observerRuns} runs)`}
                />
                <OmKV
                  c={c}
                  label="  consolidator:"
                  value={`$${data.summary.consolidatorCostUsd.toFixed(4)} (${data.summary.consolidatorRuns} runs)`}
                />
                <OmKV
                  c={c}
                  label="rollup:"
                  value={
                    data.summary.rollupFiles > 0
                      ? `${data.summary.rollupFiles} file(s) folded · $${data.summary.rollupCostUsd.toFixed(4)} preserved`
                      : "none yet"
                  }
                />
                <OmKV
                  c={c}
                  label="cost GC:"
                  value={`TTL ${data.summary.runsCostTtlDays}d${data.summary.runsCostTtlDays > 0 ? "" : " (off)"} · last sweep ${data.summary.lastRunsGcDay || "never"}`}
                />
              </>
            ) : (
              <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>no summary in projection</Text>
            )}
          </OmCard>

          <OmCard c={c} noRail>
            <OmSection c={c}>Recent events (newest first)</OmSection>
            {data.events.length === 0 ? (
              <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>no events yet</Text>
            ) : (
              data.events.map((e, i) => (
                <Text key={i} style={{ fontSize: 12, color: c.foregroundMuted }}>
                  {new Date(e.ts).toLocaleTimeString("en-GB", { hour12: false })} · {e.text.split("\n")[0]}
                </Text>
              ))
            )}
          </OmCard>
        </>
      )}
    </ScrollView>
  );
}
