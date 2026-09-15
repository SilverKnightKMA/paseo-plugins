import React, { useCallback, useState } from "react";
import { Pressable, Text, View, ScrollView, TextInput } from "react-native";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { GetTaskStateRpc, SetTaskControlRpc, GetGoalStateRpc, SetGoalControlRpc, type TaskPanelState, type GoalPanelState } from "../shared/rpc.js";
import { OmCard, OmHeader, OmSection, OmSessionPicker, omTimeAgo, omViaSuffix } from "./ui.js";
import { useLiveRpc } from "./use-live.js";

const BACKSTOP_MS = 15_000; // push-driven refresh; backstop catches new agents + dropped events

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
  // v1.0.35: amend editor — task id whose new-description input is open (user-only)
  const [amendFor, setAmendFor] = useState<number | null>(null);
  const [amendText, setAmendText] = useState("");
  // v1.0.40 (#37): goal draft/init — scope approval board
  const goalRead = useRpc(GetGoalStateRpc);
  const goalWrite = useRpc(SetGoalControlRpc);
  const [goal, setGoal] = useState<GoalPanelState | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await read({ workspaceId: props.workspaceId, sessionId: picked });
      setData(next);
      if (next.sessionId) {
        setGoal(await goalRead({ workspaceId: props.workspaceId, sessionId: next.sessionId }).catch(() => null));
      } else {
        setGoal(null);
      }
    } catch {
      // RPC hiccup — keep the last snapshot, next poll retries
    }
  }, [props.workspaceId, picked, read, goalRead]);

  useLiveRpc(refresh, BACKSTOP_MS);

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
    held: { glyph: "⚖", color: c.statusWarning }, // v1.0.47 #64: judge holds — needs evidence
    cancelled: { glyph: "×", color: c.foregroundMuted },
    parked: { glyph: "⏸", color: c.statusWarning },
  };

  /** User-only control actions (v1.0.31): fire the control file + refresh.
   *  v1.0.35: the "amend" action sends a new description written by the user (descHistory by user). */
  const sendControl = useCallback(
    async (id: number, action: "unpark" | "strict" | "reopen" | "amend", value?: boolean, description?: string) => {
      const sid = data?.sessionId;
      if (!sid) return;
      try {
        await write({ workspaceId: props.workspaceId, sessionId: sid, id, action, value, description });
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
            parked (awaiting user): {t.appealReason ?? "—"}
          </Text>
        ) : null}
        {/* v1.0.35 doneCheck guard: the agent has changed the task description before — fixed warning + old→new trail
            (the judge sees this trail too; the model can no longer change it silently) */}
        {t.descAmendments && t.descAmendments > 0 ? (
          <Text style={{ color: c.statusWarning, fontSize: 11, paddingLeft: 20 }}>
            🔨 description changed by the model {t.descAmendments}/2 times — the old version is kept
          </Text>
        ) : null}
        {t.descHistory && t.descHistory.length > 0 && !compact ? (
          <View style={{ paddingLeft: 20, gap: 1, marginTop: 1 }}>
            {t.descHistory.map((d, i) => (
              <Text key={i} style={{ color: d.by === "user" ? c.accent : c.statusWarning, fontSize: 10, opacity: 0.9 }}>
                {d.by === "user" ? "✎ user changed:" : "🔨 agent changed:"} {d.from || "(empty)"} → {d.to || "(empty)"}
              </Text>
            ))}
          </View>
        ) : null}
        {/* user-only row actions: un-park a parked task; STRICT toggle for
            any verify task (raise/lower — model can only raise, v1.4.28);
            REOPEN a closed task (v1.4.35 — evidence stays on record) */}
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
              <Text style={{ color: c.statusWarning, fontSize: 11 }}>⏸ reopen (user)</Text>
            </Pressable>
          ) : null}
          {(t.status === "completed" || t.status === "cancelled") && !hideDone ? (
            <Pressable
              onPress={() => void sendControl(t.id, "reopen")}
              style={{
                backgroundColor: c.surface1,
                borderColor: c.foregroundMuted,
                borderWidth: 1,
                borderRadius: 8,
                paddingHorizontal: 8,
                paddingVertical: 2,
              }}
            >
              <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>↺ reopen (user)</Text>
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
          {/* v1.0.35: amend description (user) — the only door when the agent has used up the 2/2 cap or the task is strict */}
          <Pressable
            onPress={() => {
              setAmendFor(amendFor === t.id ? null : t.id);
              setAmendText("");
            }}
            style={{
              backgroundColor: "transparent",
              borderColor: c.foregroundMuted,
              borderWidth: 1,
              borderRadius: 8,
              paddingHorizontal: 8,
              paddingVertical: 2,
            }}
          >
            <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>✎ amend description (user)</Text>
          </Pressable>
        </View>
        {amendFor === t.id ? (
          <View style={{ paddingLeft: 20, marginTop: 4, gap: 4 }}>
            <TextInput
              value={amendText}
              onChangeText={setAmendText}
              placeholder="new description (doneCheck) — written by the user, engine keeps the old version"
              placeholderTextColor={c.foregroundMuted}
              multiline
              style={{
                color: c.foreground,
                backgroundColor: c.surface1,
                borderColor: c.foregroundMuted,
                borderWidth: 1,
                borderRadius: 8,
                padding: 6,
                fontSize: 11,
                minHeight: 44,
                textAlignVertical: "top",
              }}
            />
            <View style={{ flexDirection: "row", gap: 6 }}>
              <Pressable
                onPress={() => {
                  const text = amendText.trim();
                  if (!text) return;
                  setAmendFor(null);
                  setAmendText("");
                  void sendControl(t.id, "amend", undefined, text);
                }}
                style={{ backgroundColor: c.surface1, borderColor: c.accent, borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}
              >
                <Text style={{ color: c.accent, fontSize: 11 }}>send new description</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setAmendFor(null);
                  setAmendText("");
                }}
                style={{ backgroundColor: "transparent", borderColor: c.foregroundMuted, borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}
              >
                <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>cancel</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
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
            {toggleChip(hideDone ? `Hide done ✓${doneHidden ? ` (${doneHidden})` : ""}` : "Show done", hideDone, () =>
              setHideDone((v) => !v),
            )}
            {toggleChip(compact ? "Compact ✓" : "Compact", compact, () => setCompact((v) => !v))}
          </View>

          {/* #37 (v1.0.40): goal draft/init — scope approval board; plan was split
              into its own "plan" plugin (v1.0.43, #62). */}
          {goal?.present && goal.status === "draft" && goal.proposal ? (
            <OmCard c={c}>
              <OmSection c={c}>GOAL — SCOPE BOARD AWAITING USER APPROVAL</OmSection>
              <View style={{ gap: 4 }}>
                <Text style={{ color: c.foreground, fontSize: 11 }}>
                  target: {goal.proposal.anchor}
                </Text>
                <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>
                  in: {goal.proposal.includeIds.length ? goal.proposal.includeIds.map((i) => `#${i}`).join(" ") : "all open tasks"}
                  {goal.proposal.excludeIds.length ? ` · drop: ${goal.proposal.excludeIds.map((i) => `#${i}`).join(" ")}` : ""}
                </Text>
                {goal.proposal.rationale ? (
                  <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>reason: {goal.proposal.rationale}</Text>
                ) : null}
                <View style={{ flexDirection: "row", gap: 6, marginTop: 2 }}>
                  <Pressable
                    onPress={() => { if (sessionId) void goalWrite({ workspaceId: props.workspaceId, sessionId, action: "confirm" }).then(refresh).catch(() => {}); }}
                    style={{ backgroundColor: c.surface1, borderColor: c.statusSuccess, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 3 }}
                  >
                    <Text style={{ color: c.statusSuccess, fontSize: 11, fontWeight: "600" }}>✓ approve — run goal</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => { if (sessionId) void goalWrite({ workspaceId: props.workspaceId, sessionId, action: "revise" }).then(refresh).catch(() => {}); }}
                    style={{ backgroundColor: c.surface1, borderColor: c.statusWarning, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 3 }}
                  >
                    <Text style={{ color: c.statusWarning, fontSize: 11 }}>↺ revise</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => { if (sessionId) void goalWrite({ workspaceId: props.workspaceId, sessionId, action: "cancel" }).then(refresh).catch(() => {}); }}
                    style={{ backgroundColor: c.surface1, borderColor: c.statusDanger, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 3 }}
                  >
                    <Text style={{ color: c.statusDanger, fontSize: 11 }}>✗ cancel</Text>
                  </Pressable>
                </View>
              </View>
            </OmCard>
          ) : null}
          {(() => {
            const pend = (data?.tasks ?? []).flatMap((t) => (t.proposals ?? []).filter((x) => x.status === "pending").map((x) => ({ task: t.id, ...x })));
            if (!pend.length) return null;
            return (
              <OmCard c={c}>
                <OmSection c={c}>DESCRIPTION AMENDMENT PROPOSALS ({pend.length}) — AMEND BLOCKED, USER DECIDES</OmSection>
                {pend.map((x) => (
                  <View key={x.id} style={{ gap: 3, marginBottom: 6 }}>
                    <Text style={{ color: c.foreground, fontSize: 11 }}>#{x.task} · {x.from.slice(0, 60)} → {x.to.slice(0, 60)}</Text>
                    {x.reason ? <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>reason: {x.reason.slice(0, 120)}</Text> : null}
                    <View style={{ flexDirection: "row", gap: 6 }}>
                      <Pressable
                        onPress={() => { if (sessionId) void write({ workspaceId: props.workspaceId, sessionId, id: x.task, action: "proposal-decide", proposalId: x.id, decision: "apply" }).then(refresh).catch(() => {}); }}
                        style={{ backgroundColor: c.surface1, borderColor: c.statusSuccess, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 3 }}
                      >
                        <Text style={{ color: c.statusSuccess, fontSize: 11, fontWeight: "600" }}>✓ apply (no cap cost)</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => { if (sessionId) void write({ workspaceId: props.workspaceId, sessionId, id: x.task, action: "proposal-decide", proposalId: x.id, decision: "reject" }).then(refresh).catch(() => {}); }}
                        style={{ backgroundColor: c.surface1, borderColor: c.statusDanger, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 3 }}
                      >
                        <Text style={{ color: c.statusDanger, fontSize: 11 }}>✗ reject</Text>
                      </Pressable>
                    </View>
                  </View>
                ))}
              </OmCard>
            );
          })()}

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
