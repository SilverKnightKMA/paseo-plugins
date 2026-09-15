import { Text, View } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";

export type MachineNoticeData = {
  kind: string;
  body: string;
};

/**
 * Renders the `<machine-notice>` envelope (#52, 2026-09-13) as a card.
 * Main-side extension notices (pool early-notice / pool aggregate) travel
 * the user-role channel — the only model-facing path in pi — so without
 * this transformer they print as if the human had typed a log line.
 * The card makes the machine origin obvious: a POOL chip + extracted pool
 * id, no user styling. Render-layer only; the transcript message the model
 * reads stays verbatim.
 *
 * Consumer side of MARKERS.md marker 5 (`pool-notice`).
 */
export function MachineNoticeCard(props: PluginTimelineItemProps<MachineNoticeData>) {
  const d = props.item.data;
  const c = props.theme.colors;

  const warn = /gate_failed|failed:|-> failed\b/.test(d.body);
  const rail = warn ? c.statusWarning : c.accent;

  // pool id from either payload form: "[pool pool-xxx] early notice: …" or "Pool pool-xxx — 2/4 done…"
  const m = /\[pool ([a-z0-9-]+)\]|^Pool ([a-z0-9-]+) —/m.exec(d.body);
  const poolId = m ? (m[1] ?? m[2]) : null;

  // body minus the leading "[pool …] " bracket so the id is not duplicated
  const body = d.body.replace(/^\[pool [a-z0-9-]+\]\s*/, "").trim();

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
            POOL
          </Text>
        </View>
        <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" as const, flexShrink: 1 }} numberOfLines={1}>
          {poolId ?? d.kind}
        </Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 11, marginLeft: "auto" }}>machine origin</Text>
      </View>
      <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{body}</Text>
    </View>
  );
}
