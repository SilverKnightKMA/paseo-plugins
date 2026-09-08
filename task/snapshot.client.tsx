import { Text, View } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin";

export type TaskSnapshotData = {
  tool: "task_create" | "task_update" | "task_list";
  tasks: { id: number; subject: string; status: "pending" | "in_progress" | "completed" | "cancelled" }[];
};

/**
 * In-flow task checklist card (v1.0.26). The pi task extension rides a full
 * task snapshot in every task_* tool result's `details` (model-invisible
 * metadata); the transformer in index.ts parses it and replaces the raw
 * tool-call entry with this card — the maintainer-blessed pattern from the
 * official pi-tasks timeline example (PR #3940). Render-layer only: the
 * transcript tool result stays intact for the model.
 */
export function TaskSnapshotCard(props: PluginTimelineItemProps<TaskSnapshotData>) {
  const d = props.item.data;
  const c = props.theme.colors;
  const done = d.tasks.filter((t) => t.status === "completed").length;
  const marker = {
    completed: "✓",
    in_progress: "▶",
    pending: "·",
    cancelled: "×",
  } as const;
  const markerColor = {
    completed: c.statusSuccess,
    in_progress: c.accent,
    pending: c.foregroundMuted,
    cancelled: c.foregroundMuted,
  } as const;

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 10,
        padding: 12,
        gap: 8,
        backgroundColor: c.surface1,
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ color: c.foreground, fontWeight: "600" }}>Tasks</Text>
          <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
            {d.tool === "task_create" ? "created" : d.tool === "task_update" ? "updated" : "listed"}
          </Text>
        </View>
        <Text style={{ color: c.foregroundMuted }}>
          {done}/{d.tasks.length}
        </Text>
      </View>
      {d.tasks.map((t) => (
        <View key={t.id} style={{ flexDirection: "row", gap: 8, opacity: t.status === "cancelled" ? 0.5 : 1 }}>
          <Text style={{ color: markerColor[t.status], width: 14 }}>{marker[t.status]}</Text>
          <Text
            style={{
              color: t.status === "completed" || t.status === "cancelled" ? c.foregroundMuted : c.foreground,
              flex: 1,
            }}
          >
            {`#${t.id} ${t.subject}`}
          </Text>
        </View>
      ))}
    </View>
  );
}
