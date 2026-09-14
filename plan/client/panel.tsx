import React, { useCallback, useState } from "react";
import { Pressable, Text, View, ScrollView } from "react-native";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { GetPlanStateRpc, ListPlanSessionsRpc, SetPlanControlRpc, type PlanPanelState, type PlanSessionBrief } from "../shared/rpc.js";
import { OmCard, OmHeader, OmSection, omTimeAgo } from "./ui.js";
import { useLiveRpc } from "./use-live.js";

const BACKSTOP_MS = 15_000; // push-driven refresh; backstop bắt session mới + event rớt

/**
 * Plan panel (v1.0.43, #62 — tách khỏi task panel theo yêu cầu user):
 * READ-ONLY projection của plan-mode + cửa USER-ONLY approve/revise/off
 * (control-file bridge, model không thể tự duyệt plan).
 * Plan tự đóng khi hết bước (engine v1.4.60) — mode "complete".
 */
export function PlanPanel(props: PluginWorkspacePanelProps) {
  const c = props.theme.colors;
  const read = useRpc(GetPlanStateRpc);
  const list = useRpc(ListPlanSessionsRpc);
  const write = useRpc(SetPlanControlRpc);
  const [data, setData] = useState<PlanPanelState | null>(null);
  const [sessions, setSessions] = useState<PlanSessionBrief[]>([]);
  const [picked, setPicked] = useState<string | null>(null); // chips override

  const refresh = useCallback(async () => {
    try {
      const l = await list({});
      setSessions(l.sessions);
      const sid = picked ?? l.sessions[0]?.sessionId ?? null;
      if (sid) setData(await read({ sessionId: sid }).catch(() => null));
      else setData(null);
    } catch {
      // RPC hiccup — giữ snapshot cũ, poll sau sẽ thử lại
    }
  }, [picked, read, list]);

  useLiveRpc(refresh, BACKSTOP_MS);

  const sessionId = picked ?? sessions[0]?.sessionId ?? null;
  const headerTitle = `Plan${sessionId ? ` · session ${sessionId.slice(0, 8)}` : ""}`;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: 8, gap: 8 }}>
      <OmHeader c={c} title={headerTitle} dim={["plan-mode projection · approve là user-only"]} />

      {sessions.length > 1 ? (
        <OmCard c={c}>
          <OmSection c={c}>SESSIONS CÓ PLAN ({sessions.length})</OmSection>
          <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
            {sessions.slice(0, 8).map((s) => (
              <Pressable
                key={s.sessionId}
                onPress={() => setPicked(s.sessionId)}
                style={{
                  backgroundColor: (sessionId === s.sessionId) ? c.surface2 : c.surface1,
                  borderColor: sessionId === s.sessionId ? c.accent : c.border,
                  borderWidth: 1,
                  borderRadius: 8,
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                }}
              >
                <Text style={{ color: c.foreground, fontSize: 10 }}>
                  {s.sessionId.slice(0, 8)} · {s.mode}
                  {s.updatedAt ? ` · ${omTimeAgo(s.updatedAt)}` : ""}
                </Text>
              </Pressable>
            ))}
          </View>
        </OmCard>
      ) : null}

      {!data || !data.present || data.mode === "inactive" ? (
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
            {data.mode === "awaiting"
              ? "CHỜ USER DUYỆT"
              : data.mode === "tracking"
                ? "ĐANG THEO DÕI"
                : data.mode === "complete"
                  ? "HOÀN THÀNH"
                  : "ĐANG VIẾT"}
          </OmSection>
          <View style={{ gap: 4 }}>
            {(() => {
              const stepsDone = data.stepsDone ?? 0;
              const stepsTotal = data.stepsTotal ?? 0;
              const pct = stepsTotal > 0 ? Math.round((stepsDone / stepsTotal) * 100) : 0;
              return (
                <>
                  <Text style={{ color: data.mode === "awaiting" ? c.statusWarning : data.mode === "complete" ? c.statusSuccess : c.foreground, fontSize: 11 }}>
                    {data.mode === "awaiting"
                      ? "model đã nộp plan — chờ bạn duyệt (approve) hoặc bảo sửa lại (revise)"
                      : data.mode === "tracking"
                        ? `đang thực thi: ${stepsDone}/${stepsTotal} bước`
                        : data.mode === "complete"
                          ? `hoàn thành ${stepsDone}/${stepsTotal} bước — plan tự đóng${data.completedAt ? ` lúc ${data.completedAt.slice(11, 16)}Z` : ""}; file giữ trong thư viện plans`
                          : "model đang viết plan (read-only mode)"}
                  </Text>
                  {data.planFile ? (
                    <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>file: {data.planFile}</Text>
                  ) : null}
                  {data.mode === "tracking" || data.mode === "complete" ? (
                    <View style={{ height: 4, borderRadius: 2, backgroundColor: c.surface2, overflow: "hidden" }}>
                      <View style={{ height: 4, width: `${pct}%`, backgroundColor: data.mode === "complete" ? c.statusSuccess : c.accent }} />
                    </View>
                  ) : null}
                  {data.mode === "tracking" && data.currentStep ? (
                    <Text style={{ color: c.foregroundMuted, fontSize: 10 }} numberOfLines={3}>
                      ▸ đang làm #{data.currentStep.index}: {data.currentStep.text}
                    </Text>
                  ) : null}
                  {data.mode === "complete" ? (
                    <Pressable
                      onPress={() => { if (sessionId) void write({ sessionId, action: "off" }).then(refresh).catch(() => {}); }}
                      style={{ backgroundColor: "transparent", borderColor: c.foregroundMuted, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 3, alignSelf: "flex-start", marginTop: 2 }}
                    >
                      <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>✕ dọn panel (off)</Text>
                    </Pressable>
                  ) : null}
                </>
              );
            })()}
            {data.mode !== "complete" ? (
              <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
                {data.mode === "awaiting" ? (
                  <Pressable
                    onPress={() => { if (sessionId) void write({ sessionId, action: "approve" }).then(refresh).catch(() => {}); }}
                    style={{ backgroundColor: c.surface1, borderColor: c.statusSuccess, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 3 }}
                  >
                    <Text style={{ color: c.statusSuccess, fontSize: 11, fontWeight: "600" }}>✓ duyệt (user)</Text>
                  </Pressable>
                ) : null}
                {data.mode === "awaiting" ? (
                  <Pressable
                    onPress={() => { if (sessionId) void write({ sessionId, action: "revise" }).then(refresh).catch(() => {}); }}
                    style={{ backgroundColor: c.surface1, borderColor: c.statusWarning, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 3 }}
                  >
                    <Text style={{ color: c.statusWarning, fontSize: 11 }}>↺ sửa lại</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  onPress={() => { if (sessionId) void write({ sessionId, action: "off" }).then(refresh).catch(() => {}); }}
                  style={{ backgroundColor: "transparent", borderColor: c.foregroundMuted, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 3 }}
                >
                  <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>✕ bỏ plan</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        </OmCard>
      )}

      <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>
        read-only projection — plan đổi qua write_plan/plan_step_done của model · approve/revise/off là user-only
      </Text>
    </ScrollView>
  );
}
