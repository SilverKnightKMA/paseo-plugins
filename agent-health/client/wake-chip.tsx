import { Text, View } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";

export type WakeChipData = {
  kind: "wake" | "wrapped" | "quiescent";
  owner: "task" | "plan";
  label: string;
  detail: string | null;
};

/** v1.0.55 (#82): continuation nudges arrive as full text blocks ([task wake
 *  3/10] … / [plan] continuation wrapped up — …). The model still reads the
 *  full text (its context is untouched); the human gets one compact line.
 *  Render-layer only — matching is by literal prefix (MARKERS.md marker 6). */
export function WakeChip(props: PluginTimelineItemProps<WakeChipData>) {
  const c = props.theme.colors;
  const icon = props.item.data.kind === "wake" ? "⚡" : props.item.data.kind === "quiescent" ? "💤" : "⏹";
  const tone = props.item.data.kind === "wake" ? c.foreground : c.foregroundMuted;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginVertical: 2 }}>
      <Text style={{ color: tone, fontSize: 12, lineHeight: 16 }}>{icon}</Text>
      <Text style={{ color: tone, fontSize: 12, lineHeight: 16 }} numberOfLines={1} ellipsizeMode="tail">
        {props.item.data.label}
      </Text>
      {props.item.data.detail ? (
        <Text style={{ color: c.foregroundMuted, fontSize: 11, lineHeight: 16 }} numberOfLines={1} ellipsizeMode="tail">
          {props.item.data.detail}
        </Text>
      ) : null}
    </View>
  );
}
