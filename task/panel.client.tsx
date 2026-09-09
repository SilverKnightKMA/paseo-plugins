import React, { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View, ScrollView } from "react-native";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin";
import { GetTaskStateRpc, SetTaskControlRpc, type TaskPanelState } from "./rpc.js";
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
  const write = useRpc(SetTaskControlRpc);
  const [data, setData] = useState<TaskPanelState | null>(null);
  const [picked, setPicked] = useState<string | null>(null); // chips override
  const [hideDone, setHideDone] = useState(true); // v1.0.32: hide completed by default (user request)
  const [compact, setCompact] = useState(false); // v1.0.32: collapse descriptions to one-line rows

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
    parked: { glyph: "⏸", color: c.statusWarning },
  };

  /** User-only control actions (v1.0.31): fire the control file + refresh. */
  const sendControl = useCallback(
    async (id: number, action: "unpark" | "strict", value?: boolean) => {
      const sid = data?.sessionId;
      if (!sid) return;
      try {
        await write({ workspaceId: props.workspaceId, sessionId: sid, id, action, value });
      } catch {
        // engine offline → file sits unacked; next poll still shows old state
      }
      void refresh();
    },
    [data?.sessionId, props.workspaceId, refresh, write],
  );

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
            {t.description && !compact ? (
              <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{t.description}</Text>
            ) : null}
          </View>
        </View>
        {t.status === "completed" && t.evidence && !compact ? (
          <Text style={{ color: c.statusSuccess, fontSize: 11, paddingLeft: 20, opacity: 0.85 }}>evidence: {t.evidence}</Text>
        ) : null}
        {t.status === "parked" ? (
          <Text style={{ color: c.statusWarning, fontSize: 11, paddingLeft: 20 }}>
            parked (chờ user): {t.appealReason ?? "—"}
          </Text>
        ) : null}
        {/* user-only row actions: un-park a parked task; STRICT toggle for
            any verify task (raise/lower — model can only raise, v1.4.28) */}
        <View style={{ flexDirection: "row", gap: 6, marginLeft: 20, marginTop: 2 }}>
          {t.status === "parked" ? (
            <Pressable
              onPress={() => void sendControl(t.id, "unpark")}
              style={{
                backgroundColor: c.surface1,
                borderColor: c.statusWarning,
                borderWidth: 1,
                borderRadius: 8,
                paddingHorizontal: 8,
                paddingVertical: 2,
              }}
            >
              <Text style={{ color: c.statusWarning, fontSize: 11 }}>⏸ mở lại (user)</Text>
            </Pressable>
          ) : null}
          {t.verify ? (
            <Pressable
              onPress={() => void sendControl(t.id, "strict", !t.verify!.strict)}
              style={{
                backgroundColor: t.verify.strict ? c.surface1 : "transparent",
                borderColor: t.verify.strict ? c.accent : c.foregroundMuted,
                borderWidth: 1,
                borderRadius: 8,
                paddingHorizontal: 8,
                paddingVertical: 2,
              }}
            >
              <Text style={{ color: t.verify.strict ? c.accent : c.foregroundMuted, fontSize: 11 }}>
                {t.verify.strict ? "STRICT ✓" : `strict · ${t.verify.lane}(${t.verify.probeCount})`}
              </Text>
            </Pressable>
          ) : null}
        </View>
        {t.judgeRounds && t.judgeRounds > 0 && !compact ? (
          <Text style={{ color: c.foregroundMuted, fontSize: 11, paddingLeft: 20 }}>
            judge rounds: {t.judgeRounds}
            {t.failStreak && t.failStreak > 0 ? ` · fail-streak ${t.failStreak}/2` : ""}
          </Text>
        ) : null}
        {openBlockers.length > 0 && !compact ? (
          <Text style={{ color: c.statusWarning, fontSize: 11, paddingLeft: 20 }}>
            blocked by {openBlockers.map((b) => `#${b.id}`).join(", ")}
          </Text>
        ) : null}
        {isReady && t.status === "pending" && !compact ? (
          <View
            style={{
              alignSelf: "flex-start",
              backgroundColor: c.surface1,
              borderColor: c.accent,
              borderWidth: 1,
              borderRadius: 8,
              paddingHorizontal: 8,
              paddingVertical: 2,
              marginLeft: 20,
              marginTop: 2,
            }}
          >
            <Text style={{ color: c.accent, fontSize: 11 }}>ready — safe to parallelize</Text>
          </View>
        ) : null}
      </View>
    );
  };

  const allNotCancelled = (data?.tasks ?? []).filter((t) => t.status !== "cancelled");
  const cancelled = (data?.tasks ?? []).filter((t) => t.status === "cancelled");
  const visible = hideDone ? allNotCancelled.filter((t) => t.status !== "completed") : allNotCancelled;
  const doneHidden = allNotCancelled.filter((t) => t.status === "completed").length;
  const open = visible.filter((t) => t.status !== "completed");

  /** v1.0.32 view toggles: hide-completed + compact rows (user request). */
  const toggleChip = (label: string, active: boolean, onPress: () => void) => (
    <Pressable
      onPress={onPress}
      style={{
        backgroundColor: active ? c.surface1 : "transparent",
        borderColor: active ? c.accent : c.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 8,
        paddingVertical: 3,
      }}
    >
      <Text style={{ color: active ? c.accent : c.foregroundMuted, fontSize: 11 }}>{label}</Text>
    </Pressable>
  );

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: 12, gap: 8 }}>
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

          <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
            {toggleChip(hideDone ? `Ẩn đã xong ✓${doneHidden ? ` (${doneHidden})` : ""}` : "Hiện đã xong", hideDone, () =>
              setHideDone((v) => !v),
            )}
            {toggleChip(compact ? "Thu gọn ✓" : "Thu gọn", compact, () => setCompact((v) => !v))}
          </View>

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
    </ScrollView>
  );
}
