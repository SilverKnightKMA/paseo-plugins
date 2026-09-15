import React, { useCallback, useState } from "react";
import { Pressable, Text, View, ScrollView } from "react-native";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { GetPlanStateRpc, SetPlanControlRpc, type PlanPanelState } from "../shared/rpc.js";
import { OmCard, OmHeader, OmSection, OmSessionPicker, omViaSuffix } from "./ui.js";
import { useLiveRpc } from "./use-live.js";

const BACKSTOP_MS = 15_000; // push-driven refresh; backstop catches new sessions + dropped events

/**
 * Plan panel (v1.0.45, #62): the session filter shares SEMANTICS with task/snip
 * (chips via the shared session-filter). READ-ONLY projection of plan-mode plus
 * a USER-ONLY approve/revise/off door (control-file bridge). Steps render as a
 * checklist like task rows (engine v1.4.62 puts steps intact into the payload).
 * The plan auto-closes when all steps are done (mode "complete").
 */
export function PlanPanel(props: PluginWorkspacePanelProps) {
  const c = props.theme.colors;
  const read = useRpc(GetPlanStateRpc);
  const write = useRpc(SetPlanControlRpc);
  const [data, setData] = useState<PlanPanelState | null>(null);
  const [picked, setPicked] = useState<string | null>(null); // chips override

  const refresh = useCallback(async () => {
    try {
      setData(await read({ workspaceId: props.workspaceId, sessionId: picked }));
    } catch {
      // RPC hiccup — keep the last snapshot, the next poll retries
    }
  }, [props.workspaceId, picked, read]);

  useLiveRpc(refresh, BACKSTOP_MS);

  const sessionId = data?.sessionId;
  const resolved = data?.resolved;
  const headerTitle = `Plan${sessionId ? ` · session ${sessionId.slice(0, 8)}${omViaSuffix(resolved?.via)}` : ""}`;
  const mode = data?.mode;
  const steps = data?.steps ?? [];
  const currentIdx = data?.currentStep?.index ?? null;

  const engineLine = !data
    ? "loading…"
    : !data.present
      ? (data.note ?? "no session")
      : mode === "inactive"
        ? "plan mode not used in this session yet"
        : (data.note ?? "ok");

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: 8, gap: 8 }}>
      {/* v1.0.47 (#65): the no-plan state trimmed to ONE caveat — previously the dim
          header + empty card + footer each said "user-only/projection" 3 times, reading like duplicate cards */}
      <OmHeader
        c={c}
        title={headerTitle}
        dim={
          !data || !data.present || mode === "inactive"
            ? [engineLine]
            : [engineLine, steps.length > 0 ? `${data?.stepsDone ?? 0}/${steps.length} steps · ${mode}` : "no plan for this session yet"]
        }
      />
      <OmSessionPicker
        c={c}
        sessions={(data?.sessions ?? []).map((s) => ({
          sessionId: s.sessionId,
          label: `${s.active ? "● " : ""}${s.title ? s.title.slice(0, 24) : s.sessionId.slice(0, 8)}`,
          active: s.active,
        }))}
        selectedId={sessionId}
        onPick={(id) => setPicked(id)}
        min={1}
      />

      {(!data || !data.present || mode === "inactive") && (data?.sessions ?? []).length === 0 ? (
        <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>
          no session in this workspace has a plan status yet — the picker gets chips after the plan engine first runs
        </Text>
      ) : null}

      {/* v1.0.48 (#65/#67): the empty "PLAN" card merged into the dim header above — a single card. */}
      {data?.present && mode !== "inactive" && mode !== undefined ? (
        <OmCard c={c}>
          <OmSection c={c}>
            PLAN —{" "}
            {mode === "awaiting"
              ? "AWAITING USER APPROVAL"
              : mode === "tracking"
                ? "TRACKING"
                : mode === "complete"
                  ? "COMPLETE"
                  : "DRAFTING"}
          </OmSection>
          <View style={{ gap: 4 }}>
            {(() => {
              const stepsDone = data?.stepsDone ?? 0;
              const stepsTotal = data?.stepsTotal ?? 0;
              const pct = stepsTotal > 0 ? Math.round((stepsDone / stepsTotal) * 100) : 0;
              return (
                <>
                  <Text
                    style={{
                      color: mode === "awaiting" ? c.statusWarning : mode === "complete" ? c.statusSuccess : c.foreground,
                      fontSize: 11,
                    }}
                  >
                    {mode === "awaiting"
                      ? "the model has submitted a plan — waiting for you to approve or ask for a revision"
                      : mode === "tracking"
                        ? `executing: ${stepsDone}/${stepsTotal} steps`
                        : mode === "complete"
                          ? `completed ${stepsDone}/${stepsTotal} steps — the plan auto-closes${data?.completedAt ? ` at ${data.completedAt.slice(11, 16)}Z` : ""}; the file stays in the plans library`
                          : "the model is writing the plan (read-only mode)"}
                  </Text>
                  {data?.planFile ? (
                    <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>file: {data.planFile}</Text>
                  ) : null}
                  {mode === "awaiting" && data?.planText ? (
                    <View
                      style={{
                        marginTop: 4,
                        borderWidth: 1,
                        borderColor: c.surface2,
                        borderRadius: 6,
                        padding: 6,
                        backgroundColor: c.surface1,
                      }}
                    >
                      <Text style={{ color: c.foregroundMuted, fontSize: 9 }}>
                        plan content — read it here, then approve:{" "}
                      </Text>
                      <Text style={{ color: c.foreground, fontSize: 10 }}>{data.planText}</Text>
                    </View>
                  ) : null}
                  {mode === "tracking" || mode === "complete" ? (
                    <View style={{ height: 4, borderRadius: 2, backgroundColor: c.surface2, overflow: "hidden" }}>
                      <View
                        style={{
                          height: 4,
                          width: `${pct}%`,
                          backgroundColor: mode === "complete" ? c.statusSuccess : c.accent,
                        }}
                      />
                    </View>
                  ) : null}
                </>
              );
            })()}

            {steps.length > 0 ? (
              <View style={{ gap: 3, marginTop: 4 }}>
                {steps.map((s) => {
                  // v1.0.54 (#47 Phase B): bridged steps derive their glyph from the
                  // step-task's live status — ✓ verified-done · ⚖ judge held · ▸ in
                  // progress · ○ pending. Unbridged steps keep the old ✓/▸/○ set.
                  const st = s.taskRef?.status;
                  const glyph = s.done
                    ? "✓"
                    : st === "held"
                      ? "⚖"
                      : st === "in_progress"
                        ? "▸"
                        : st === "completed"
                          ? "✓"
                          : currentIdx === s.index
                            ? "▸"
                            : "○";
                  const glyphColor = s.done
                    ? c.statusSuccess
                    : st === "held"
                      ? c.statusWarning
                      : st === "in_progress" || currentIdx === s.index
                        ? c.accent
                        : c.foregroundMuted;
                  return (
                    <View key={s.index} style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }}>
                      <Text style={{ color: glyphColor, fontSize: 11 }}>{glyph}</Text>
                      <Text
                        style={{
                          color: s.done ? c.foregroundMuted : currentIdx === s.index ? c.foreground : c.foregroundMuted,
                          fontSize: 10,
                          flex: 1,
                          textDecorationLine: s.done ? "line-through" : "none",
                        }}
                      >
                        {s.text}
                        {s.taskRef ? <Text style={{ color: c.foregroundMuted, fontSize: 9 }}> #{s.taskRef.id}</Text> : null}
                      </Text>
                    </View>
                  );
                })}
              </View>
            ) : null}

            {mode === "complete" ? (
              <Pressable
                onPress={() => {
                  if (sessionId) void write({ sessionId, action: "off" }).then(refresh).catch(() => {});
                }}
                style={{
                  backgroundColor: "transparent",
                  borderColor: c.foregroundMuted,
                  borderWidth: 1,
                  borderRadius: 8,
                  paddingHorizontal: 10,
                  paddingVertical: 3,
                  alignSelf: "flex-start",
                  marginTop: 4,
                }}
              >
                <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>✕ clear panel (off)</Text>
              </Pressable>
            ) : (
              <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                {mode === "awaiting" ? (
                  <Pressable
                    onPress={() => {
                      if (sessionId) void write({ sessionId, action: "approve" }).then(refresh).catch(() => {});
                    }}
                    style={{ backgroundColor: c.surface1, borderColor: c.statusSuccess, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 3 }}
                  >
                    <Text style={{ color: c.statusSuccess, fontSize: 11, fontWeight: "600" }}>✓ approve (user)</Text>
                  </Pressable>
                ) : null}
                {mode === "awaiting" ? (
                  <Pressable
                    onPress={() => {
                      if (sessionId) void write({ sessionId, action: "revise" }).then(refresh).catch(() => {});
                    }}
                    style={{ backgroundColor: c.surface1, borderColor: c.statusWarning, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 3 }}
                  >
                    <Text style={{ color: c.statusWarning, fontSize: 11 }}>↺ revise</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  onPress={() => {
                    if (sessionId) void write({ sessionId, action: "off" }).then(refresh).catch(() => {});
                  }}
                  style={{ backgroundColor: "transparent", borderColor: c.foregroundMuted, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 3 }}
                >
                  <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>✕ drop plan</Text>
                </Pressable>
              </View>
            )}
          </View>
        </OmCard>
      ) : null}

      {data?.present && mode !== "inactive" ? (
        <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>
          read-only projection — the plan changes via the model's write_plan/plan_step_done · approve/revise/off are user-only
        </Text>
      ) : null}
    </ScrollView>
  );
}
