import { Text, View } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";

export type OmLogData = {
  text: string;
};

/** Compact card for om status chatter ("om: observer started…", "om:
 *  compaction complete") that used to render as full-width info banners.
 *  Shows the LAST line (the end state, e.g. "compaction complete") plus a
 *  "+N log line(s)" hint for the intermediate steps. Render-layer only. */
export function OmLogCard(props: PluginTimelineItemProps<OmLogData>) {
  const c = props.theme.colors;
  const lines = props.item.data.text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const summary = lines.length > 0 ? lines[lines.length - 1] : "";
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
        marginVertical: 2,
        padding: 6,
        borderRadius: 8,
        backgroundColor: c.surface0,
        borderLeftWidth: 3,
        borderLeftColor: c.accent,
      }}
    >
      <Text style={{ color: c.accent, fontSize: 11, lineHeight: 16, fontWeight: "600" }}>om</Text>
      <View style={{ flexDirection: "column", gap: 1, flexShrink: 1 }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }} numberOfLines={1} ellipsizeMode="tail">
          {summary}
        </Text>
        {lines.length > 1 ? (
          <Text style={{ color: c.foregroundMuted, fontSize: 11, lineHeight: 15 }}>+{lines.length - 1} log line(s)</Text>
        ) : null}
      </View>
    </View>
  );
}
