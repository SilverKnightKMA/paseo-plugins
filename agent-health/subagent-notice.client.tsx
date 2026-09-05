import { Text, View } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin";

export type SubagentNoticeData = {
  role: string;
  kind: string;
  agentId: string;
  name: string | null;
  body: string;
  tone: "ok" | "info" | "warn";
};

/**
 * Renders the `<subagent-message>` block (auto-report / channel-nack /
 * handoff replies) as a proper card instead of the raw leaked XML tags the
 * app would otherwise print. The transformer (index.ts) parses + cleans the
 * text — dedupes the agent UUID, extracts the friendly name and notice kind —
 * and this component only draws: role badge, name, body, hint line.
 *
 * Render-layer only: the transcript message stays intact for the model.
 */
export function SubagentNoticeCard(props: PluginTimelineItemProps<SubagentNoticeData>) {
  const d = props.item.data;
  const c = props.theme.colors;
  const rail = d.tone === "ok" ? c.statusSuccess : d.tone === "warn" ? c.statusWarning : c.accent;

  // tách câu hint cuối (bắt đầu bằng "Dùng "/"Use ") để hạ cấp visual
  const bodyLines = d.body.split("\n");
  const lastLine = bodyLines[bodyLines.length - 1].trim();
  const isHint = /^(dùng|use)\s/i.test(lastLine) && bodyLines.length > 1;
  const body = isHint ? bodyLines.slice(0, -1).join("\n").trim() : d.body;
  const hint = isHint ? lastLine : null;

  return (
    <View
      style={{
        backgroundColor: c.surface1,
        borderColor: c.border,
        borderWidth: 1,
        borderLeftColor: rail,
        borderLeftWidth: 3,
        borderRadius: 8,
        paddingVertical: 8,
        paddingHorizontal: 10,
        marginVertical: 4,
        gap: 4,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View
          style={{
            backgroundColor: c.surface2,
            borderColor: c.border,
            borderWidth: 1,
            borderRadius: 4,
            paddingHorizontal: 6,
            paddingVertical: 1,
          }}
        >
          <Text style={{ color: rail, fontSize: 10, fontWeight: "700" as const, letterSpacing: 0.5 }}>
            {d.role.toUpperCase()}
          </Text>
        </View>
        <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" as const, flexShrink: 1 }} numberOfLines={1}>
          {d.name ?? `${d.agentId.slice(0, 8)}…`}
        </Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 11, marginLeft: "auto" }}>{d.kind}</Text>
      </View>
      {body.length > 0 ? (
        <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{body}</Text>
      ) : null}
      {hint ? (
        <Text style={{ color: c.foregroundMuted, fontSize: 11, fontStyle: "italic" as const }}>{hint}</Text>
      ) : null}
    </View>
  );
}
