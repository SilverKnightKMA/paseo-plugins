import { Text, View } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";

export type SystemChipData = {
  notice: string;
};

/** One dim line for system notices that used to render as full raw text
 *  (e.g. the pi compaction continuation notice — model-facing prose the
 *  user does not need to read in full). Render-layer only. */
export function SystemChip(props: PluginTimelineItemProps<SystemChipData>) {
  const c = props.theme.colors;
  const label =
    props.item.data.notice === "context-compacted"
      ? "context compacted automatically — continuing where it left off"
      : props.item.data.notice;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginVertical: 2 }}>
      <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>🧹</Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }} numberOfLines={1} ellipsizeMode="tail">
        {label}
      </Text>
    </View>
  );
}
