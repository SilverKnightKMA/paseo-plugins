import { Text, View } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin";

export type MutedAbortData = {
  message: string;
  /**
   * relay-drop — stopReason=error + undici AbortError: the provider/proxy
   *   dropped the streaming connection mid-turn (zaicp relay flap). The turn
   *   died; nothing is queued. Retrying ("tiếp tục") resumes from the last
   *   saved state. Must be VISIBLE or the agent looks hung.
   * superseded — stopReason=aborted / "Request aborted": the turn was cut on
   *   purpose (user stop, or daemon interrupt-and-replace when a child
   *   notification / new prompt arrived). Benign; muted line is enough.
   */
  cls: "relay-drop" | "superseded";
};

/** Pull "model=…" out of the raw error message for the hint line, if present. */
function modelOf(message: string): string | null {
  const m = /model=([^)\s]+)/.exec(message);
  return m ? m[1] : null;
}

export function MutedAbortCard(props: PluginTimelineItemProps<MutedAbortData>) {
  const d = props.item.data;
  const c = props.theme.colors;

  if (d.cls === "superseded") {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginVertical: 2 }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>⏹</Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }} numberOfLines={1} ellipsizeMode="tail">
          turn bị hủy (aborted) — không phải lỗi; tin nhắn mới đã vào hàng đợi
        </Text>
      </View>
    );
  }

  // relay-drop: warning card — distinguish "chết" from "treo" at a glance.
  const model = modelOf(d.message);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
        marginVertical: 4,
        padding: 8,
        borderRadius: 8,
        backgroundColor: c.surface1,
        borderLeftWidth: 3,
        borderLeftColor: c.statusWarning,
      }}
    >
      <Text style={{ color: c.statusWarning, fontSize: 13, lineHeight: 18 }}>⚠</Text>
      <View style={{ flexDirection: "column", gap: 2, flexShrink: 1 }}>
        <Text style={{ color: c.foreground, fontSize: 12, fontWeight: "600", lineHeight: 17 }}>
          Request bị đứt (provider/relay) — lỗi mạng, không mất dữ liệu
        </Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
          gõ "tiếp tục" để chạy lại từ điểm dừng{model ? ` · ${model}` : ""}
        </Text>
      </View>
    </View>
  );
}
