import { Text, View } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin";

export type MutedAbortData = {
  message: string;
};

/**
 * Mid-turn aborts (user sends a new message/voice while a request is in
 * flight, or the proxy times out) end the turn with
 * "[System Error] This operation was aborted (stopReason=error …)" — scary
 * and misleading, because nothing is actually wrong: the turn was simply
 * superseded. Render-layer only: swap the error item for one muted line.
 * The transcript keeps the raw error for the model.
 */
export function MutedAbortCard(props: PluginTimelineItemProps<MutedAbortData>) {
  const d = props.item.data;
  const c = props.theme.colors;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginVertical: 2 }}>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>⏹</Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }} numberOfLines={1} ellipsizeMode="tail">
        turn bị hủy (aborted) — không phải lỗi; tin nhắn mới đã vào hàng đợi
      </Text>
    </View>
  );
}
