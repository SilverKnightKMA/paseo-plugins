import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin";

export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled" | "parked";

export type TaskSnapshotData = {
  tool: "task_create" | "task_update" | "task_list";
  tasks: { id: number; subject: string; status: TaskStatus }[];
  /** v1.4.29/v1.0.32: compact prev→next diff for the affected task. When
   *  present the card shows ONLY the diff plus a collapsed full-snapshot
   *  expander (user request: cards were too long). Absent on task_list. */
  changes?: { id: number; subject: string; from: TaskStatus | null; to: TaskStatus }[];
};

const marker = {
  completed: "✓",
  in_progress: "▶",
  pending: "·",
  cancelled: "×",
  parked: "⏸",
} as const;

/**
 * In-flow task card (v1.0.26; diff-first since v1.0.32). The pi task
 * extension rides a full snapshot + a compact changes diff in every task_*
 * tool result's `details` (model-invisible metadata); the transformer in
 * index.ts parses it and replaces the raw tool-call entry with this card —
 * the maintainer-blessed pattern from the official pi-tasks timeline example
 * (PR #3940). Render-layer only: the transcript tool result stays intact
 * for the model.
 */
export function TaskSnapshotCard(props: PluginTimelineItemProps<TaskSnapshotData>) {
  const d = props.item.data;
  const c = props.theme.colors;
  const [expanded, setExpanded] = useState(false);
  const done = d.tasks.filter((t) => t.status === "completed").length;
  const markerColor = {
    completed: c.statusSuccess,
    in_progress: c.accent,
    pending: c.foregroundMuted,
    cancelled: c.foregroundMuted,
    parked: c.statusWarning,
  } as const;
  const hasDiff = Array.isArray(d.changes) && d.changes.length > 0 && d.tool !== "task_list";

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

      {hasDiff
        ? d.changes!.map((ch) => (
            <View key={ch.id} style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
              <Text style={{ color: markerColor[ch.to], width: 14 }}>{marker[ch.to]}</Text>
              <Text style={{ color: c.foreground, flex: 1, fontSize: 12 }}>
                {`#${ch.id} ${ch.subject}`}
              </Text>
              <Text style={{ color: c.foregroundMuted, fontFamily: "monospace", fontSize: 11 }}>
                {ch.from ? `${ch.from} → ${ch.to}` : `+ ${ch.to}`}
              </Text>
            </View>
          ))
        : d.tasks.map((t) => (
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

      {hasDiff ? (
        <Pressable onPress={() => setExpanded((v) => !v)} style={{ alignSelf: "flex-start", paddingVertical: 2 }}>
          <Text style={{ color: c.accent, fontSize: 11, fontFamily: "monospace" }}>
            {expanded ? "▾ collapse snapshot" : "▸ snapshot"}
          </Text>
        </Pressable>
      ) : null}

      {hasDiff && expanded
        ? d.tasks.map((t) => (
            <View key={t.id} style={{ flexDirection: "row", gap: 8, opacity: t.status === "cancelled" ? 0.5 : 1 }}>
              <Text style={{ color: markerColor[t.status], width: 14 }}>{marker[t.status]}</Text>
              <Text
                style={{
                  color: t.status === "completed" || t.status === "cancelled" ? c.foregroundMuted : c.foreground,
                  flex: 1,
                  fontSize: 11,
                }}
              >
                {`#${t.id} ${t.subject}`}
              </Text>
            </View>
          ))
        : null}
    </View>
  );
}
