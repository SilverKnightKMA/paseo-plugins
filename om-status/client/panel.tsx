import React, { useCallback, useState } from "react";
import { Text, View, ScrollView, Pressable } from "react-native";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { GetOmStatusRpc, GetOmTopicsRpc, type OmTopic } from "../shared/rpc.js";
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

/** #244 (M3): one topic row — name · size · updated, expandable head lines. */
function OmTopicRow({ c, topic }: { c: OmColors; topic: OmTopic }) {
  const [open, setOpen] = useState(false);
  const kb = topic.sizeBytes >= 1024 ? `${(topic.sizeBytes / 1024).toFixed(1)}K` : `${topic.sizeBytes}B`;
  const updated = topic.updatedAt.slice(0, 16).replace("T", " ");
  return (
    <View style={{ marginBottom: 4 }}>
      <Pressable onPress={() => setOpen(!open)} style={{ flexDirection: "row" as const, gap: 6 }}>
        <Text style={{ color: c.foreground, fontSize: 11, fontFamily: "monospace", flexShrink: 1 }}>
          {open ? "▾" : "▸"} {topic.name}
        </Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 11, fontFamily: "monospace" }}>
          {kb} · {updated}
        </Text>
      </Pressable>
      {open ? (
        topic.head.length === 0 ? (
          <Text style={{ color: c.foregroundMuted, fontSize: 10, fontFamily: "monospace", paddingLeft: 18 }}>(empty)</Text>
        ) : (
          topic.head.map((h, i) => (
            <Text key={i} style={{ color: c.foregroundMuted, fontSize: 10, fontFamily: "monospace", paddingLeft: 18 }}>
              {h}
            </Text>
          ))
        )
      ) : null}
    </View>
  );
}

/** #244 (M3): the Topics view — on-demand GetOmTopicsRpc (never in the live poll). */
export function TopicsView({ c, workspaceId, sessionId }: { c: OmColors; workspaceId: string; sessionId: string | null }) {
  const read = useRpc(GetOmTopicsRpc);
  const [topics, setTopics] = useState<OmTopic[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!sessionId) return;
    try {
      const next = await read({ workspaceId, sessionId });
      setTopics(next.topics);
      setNote(next.note ?? null);
    } catch {
      // keep last; user can re-open
    }
  }, [read, sessionId, workspaceId]);
  React.useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <OmCard c={c} noRail>
      <OmSection c={c}>Topic files ({topics ? topics.length : "…"})</OmSection>
      {topics == null ? (
        <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>loading…</Text>
      ) : topics.length === 0 ? (
        <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{note ?? "no topic files"}</Text>
      ) : (
        topics.map((t) => <OmTopicRow key={t.name} c={c} topic={t} />)
      )}
    </OmCard>
  );
}

/** #244 (M3): standalone Topics panel — the composer pill's direct target.
 *  Resolves the session via the status RPC (agentId > workspace-active),
 *  then renders the on-demand TopicsView. */
export function OmTopicsPanel(props: PluginWorkspacePanelProps) {
  const read = useRpc(GetOmStatusRpc);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const next = await read({ workspaceId: props.workspaceId });
      setSessionId(next.resolved?.sessionId ?? null);
    } catch {
      // keep last resolved; backstop retries
    }
  }, [props.workspaceId, read]);
  useLiveRpc(refresh, BACKSTOP_MS);
  const c = props.theme.colors;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: 12, gap: 8 }}>
      <TopicsView c={c} workspaceId={props.workspaceId} sessionId={sessionId} />
    </ScrollView>
  );
}

export function OmStatusPanel(props: PluginWorkspacePanelProps) {
  const read = useRpc(GetOmStatusRpc);
  const [data, setData] = useState<Awaited<ReturnType<typeof read>> | null>(null);
  const [picked, setPicked] = useState<string | null>(null); // chips override
  // #244 (M3): segmented view — Status (default) | Topics
  const [view, setView] = useState<"status" | "topics">("status");

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
      <View style={{ flexDirection: "row" as const, gap: 6 }}>
        {(["status", "topics"] as const).map((v) => (
          <Pressable
            key={v}
            onPress={() => setView(v)}
            style={{
              paddingVertical: 3,
              paddingHorizontal: 10,
              borderRadius: 6,
              backgroundColor: view === v ? c.accent : c.surface1,
            }}
          >
            <Text style={{ color: view === v ? c.surface0 : c.foregroundMuted, fontSize: 11, fontWeight: "600" as const }}>
              {v === "status" ? "Status" : "Topics"}
            </Text>
          </Pressable>
        ))}
      </View>
      {view === "topics" ? (
        data?.resolved?.sessionId ? (
          <TopicsView c={c} workspaceId={props.workspaceId} sessionId={data.resolved.sessionId} />
        ) : (
          <OmCard c={c} noRail>
            <Text style={{ fontSize: 12, color: c.foregroundMuted }}>
              {data == null ? "loading…" : data.note ?? "no session resolved — pick one on the Status view first"}
            </Text>
          </OmCard>
        )
      ) : data == null ? (
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
