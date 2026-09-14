import React, { useCallback, useState } from "react";
import { Pressable, Text, View, ScrollView } from "react-native";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { GetPlanStateRpc, SetPlanControlRpc, type PlanPanelState } from "../shared/rpc.js";
import { OmCard, OmHeader, OmSection, OmSessionPicker, omViaSuffix } from "./ui.js";
import { useLiveRpc } from "./use-live.js";

const BACKSTOP_MS = 15_000; // push-driven refresh; backstop bắt session mới + event rớt

/**
 * Plan panel (v1.0.45, #62): session filter dùng CHUNG semantics với task/snip
 * (chips qua shared session-filter). READ-ONLY projection của plan-mode +
 * cửa USER-ONLY approve/revise/off (control-file bridge). Steps render dạng
 * checklist như task rows (engine v1.4.62 đưa steps nguyên vẹn vào payload).
 * Plan tự đóng khi hết bước (mode "complete").
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
      // RPC hiccup — giữ snapshot cũ, poll sau sẽ thử lại
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
        ? "chưa dùng plan mode trong session này"
        : (data.note ?? "ok");

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: 8, gap: 8 }}>
      <OmHeader
        c={c}
        title={headerTitle}
        dim={[
          engineLine,
          steps.length > 0 ? `${data?.stepsDone ?? 0}/${steps.length} bước · ${mode}` : "plan-mode projection · approve là user-only",
        ]}
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
      />

      {!data || !data.present || mode === "inactive" ? (
        <OmCard c={c}>
          <OmSection c={c}>PLAN</OmSection>
          <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
            chưa có plan cho session này — model vào plan mode qua enter_plan_mode / write_plan; sau khi model
            nộp plan, bảng duyệt hiện ở đây
          </Text>
        </OmCard>
      ) : (
        <OmCard c={c}>
          <OmSection c={c}>
            PLAN —{" "}
            {mode === "awaiting"
              ? "CHỜ USER DUYỆT"
              : mode === "tracking"
                ? "ĐANG THEO DÕI"
                : mode === "complete"
                  ? "HOÀN THÀNH"
                  : "ĐANG VIẾT"}
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
                      ? "model đã nộp plan — chờ bạn duyệt (approve) hoặc bảo sửa lại (revise)"
                      : mode === "tracking"
                        ? `đang thực thi: ${stepsDone}/${stepsTotal} bước`
                        : mode === "complete"
                          ? `hoàn thành ${stepsDone}/${stepsTotal} bước — plan tự đóng${data?.completedAt ? ` lúc ${data.completedAt.slice(11, 16)}Z` : ""}; file giữ trong thư viện plans`
                          : "model đang viết plan (read-only mode)"}
                  </Text>
                  {data?.planFile ? (
                    <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>file: {data.planFile}</Text>
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
                {steps.map((s) => (
                  <View key={s.index} style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }}>
                    <Text style={{ color: s.done ? c.statusSuccess : currentIdx === s.index ? c.accent : c.foregroundMuted, fontSize: 11 }}>
                      {s.done ? "✓" : currentIdx === s.index ? "▸" : "○"}
                    </Text>
                    <Text
                      style={{
                        color: s.done ? c.foregroundMuted : currentIdx === s.index ? c.foreground : c.foregroundMuted,
                        fontSize: 10,
                        flex: 1,
                        textDecorationLine: s.done ? "line-through" : "none",
                      }}
                    >
                      {s.text}
                    </Text>
                  </View>
                ))}
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
                <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>✕ dọn panel (off)</Text>
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
                    <Text style={{ color: c.statusSuccess, fontSize: 11, fontWeight: "600" }}>✓ duyệt (user)</Text>
                  </Pressable>
                ) : null}
                {mode === "awaiting" ? (
                  <Pressable
                    onPress={() => {
                      if (sessionId) void write({ sessionId, action: "revise" }).then(refresh).catch(() => {});
                    }}
                    style={{ backgroundColor: c.surface1, borderColor: c.statusWarning, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 3 }}
                  >
                    <Text style={{ color: c.statusWarning, fontSize: 11 }}>↺ sửa lại</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  onPress={() => {
                    if (sessionId) void write({ sessionId, action: "off" }).then(refresh).catch(() => {});
                  }}
                  style={{ backgroundColor: "transparent", borderColor: c.foregroundMuted, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 3 }}
                >
                  <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>✕ bỏ plan</Text>
                </Pressable>
              </View>
            )}
          </View>
        </OmCard>
      )}

      <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>
        read-only projection — plan đổi qua write_plan/plan_step_done của model · approve/revise/off là user-only
      </Text>
    </ScrollView>
  );
}
