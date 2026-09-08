import React, { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin";
import { GetTaskStateRpc, type TaskPanelState } from "./rpc.js";
import { OmCard, OmHeader, OmSection, OmSessionPicker, omTimeAgo, omViaSuffix } from "./ui.js";

const POLL_MS = 2000;

/**
 * Task panel: READ-ONLY presentation of the session task list (statuses,
 * blockers, ready set, evidence). Tasks change only via the model's
 * task_create/task_update tools; the projection file is the engine's truth.
 */
export function TaskPanel(props: PluginWorkspacePanelProps) {
  const c = props.theme.colors;
  const read = useRpc(GetTaskStateRpc);
  const [data, setData] = useState<TaskPanelState | null>(null);
  const [picked, setPicked] = useState<string | null>(null); // chips override

  const refresh = useCallback(async () => {
    try {
      setData(await read({ workspaceId: props.workspaceId, sessionId: picked }));
    } catch {
      // RPC hiccup — keep the last snapshot, next poll retries
    }
  }, [props.workspaceId, picked, read]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const sessionId = data?.sessionId;
  const resolved = data?.resolved;
  const headerTitle = `Tasks${sessionId ? ` · session ${sessionId.slice(0, 8)}${omViaSuffix(resolved?.via)}` : ""}`;
  const engineLine = !data
    ? "loading…"
    : !data.present
      ? (data.note ?? "no session")
      : !data.engineLive
        ? `engine offline — ${data.note ?? "session has not loaded task v1.4.21+"}`
        : `engine ok · written ${omTimeAgo(data.writtenAt)}`;

  const statusGlyph: Record<string, { glyph: string; color: string }> = {
    completed: { glyph: "✓", color: c.statusSuccess },
    in_progress: { glyph: "▶", color: c.accent },
    pending: { glyph: "·", color: c.foregroundMuted },
    cancelled: { glyph: "×", color: c.foregroundMuted },
  };

  const row = (t: TaskPanelState["tasks"][number], all: TaskPanelState["tasks"]) => {
    const g = statusGlyph[t.status] ?? statusGlyph.pending!;
    const openBlockers = t.blockedBy
      .map((id) => all.find((x) => x.id === id))
      .filter((b): b is NonNullable<typeof b> => Boolean(b) && b!.status !== "completed" && b!.status !== "cancelled");
    const isReady = data?.ready.includes(t.id) ?? false;
    return (
      <View key={t.id} style={{ paddingVertical: 5, gap: 2 }}>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Text style={{ color: g.color, fontFamily: "monospace", fontSize: 12, fontWeight: "700" }}>{g.glyph}</Text>
          <View style={{ flexShrink: 1 }}>
            <Text
              style={{
                color: t.status === "cancelled" ? c.foregroundMuted : c.foreground,
                fontSize: 12,
                fontWeight: t.status === "in_progress" ? "600" : "400",
                textDecorationLine: t.status === "cancelled" ? "line-through" : "none",
              }}
            >
              #{t.id} {t.subject}
            </Text>
            {t.description ? <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{t.description}</Text> : null}
          </View>
        </View>
        {t.status === "completed" && t.evidence ? (
          <Text style={{ color: c.statusSuccess, fontSize: 11, paddingLeft: 20, opacity: 0.85 }}>evidence: {t.evidence}</Text>
        ) : null}
        {openBlockers.length > 0 ? (
          <Text style={{ color: c.statusWarning, fontSize: 11, paddingLeft: 20 }}>
            blocked by {openBlockers.map((b) => `#${b.id}`).join(", ")}
          </Text>
        ) : null}
        {isReady && t.status === "pending" ? (
          <Text style={{ color: c.accent, fontSize: 11, paddingLeft: 20, opacity: 0.85 }}>ready — safe to parallelize</Text>
        ) : null}
      </View>
    );
  };

  const visible = (data?.tasks ?? []).filter((t) => t.status !== "cancelled");
  const cancelled = (data?.tasks ?? []).filter((t) => t.status === "cancelled");
  const open = visible.filter((t) => t.status !== "completed");

  return (
    <View style={{ flex: 1, padding: 12, gap: 8, backgroundColor: c.surface0 }}>
      {data == null ? (
        <Text style={{ color: c.foregroundMuted }}>loading…</Text>
      ) : !data.present ? (
        <Text style={{ color: c.foregroundMuted }}>{data.note ?? "no session"}</Text>
      ) : (
        <>
          <OmHeader
            c={c}
            title={headerTitle}
            dim={[
              ...(resolved?.agentTitle ? [`agent: ${resolved.agentTitle}`] : []),
              engineLine,
              data.total === 0
                ? "no tasks yet — ask the agent to plan with task_create"
                : `${data.done}/${data.total} done · ${data.inProgress} active · ${data.pending} pending · ${data.ready.length} ready`,
            ]}
          />
          <OmSessionPicker
            c={c}
            sessions={(data.sessions ?? []).map((s) => ({
              sessionId: s.sessionId,
              label: `${s.active ? "● " : ""}${s.title ? s.title.slice(0, 24) : s.sessionId.slice(0, 8)}`,
              active: s.active,
            }))}
            selectedId={sessionId}
            onPick={(id) => setPicked(id)}
          />

          <OmCard c={c}>
            <OmSection c={c}>TASKS — {open.length} open</OmSection>
            {visible.length === 0 ? (
              <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>(list empty)</Text>
            ) : (
              visible.map((t) => row(t, data.tasks))
            )}
          </OmCard>

          {cancelled.length > 0 ? (
            <OmCard c={c}>
              <OmSection c={c}>CANCELLED — {cancelled.length}</OmSection>
              {cancelled.map((t) => row(t, data.tasks))}
            </OmCard>
          ) : null}

          <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>
            read-only projection — tasks change via the model's task_create/task_update tools · evidence-gated completion
          </Text>
        </>
      )}
    </View>
  );
}
