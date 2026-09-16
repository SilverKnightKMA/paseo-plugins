import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";

export type TaskStatus = "pending" | "in_progress" | "held" | "completed" | "cancelled" | "parked";

export type TaskSnapshotData = {
  tool: "task_create" | "task_update" | "task_list";
  tasks: { id: number; subject: string; status: TaskStatus }[];
  /** v1.4.29/v1.0.32: compact prev→next diff for the affected task. When
   *  present the card shows ONLY the diff plus a collapsed full-snapshot
   *  expander (user request: cards were too long). Absent on task_list. */
  changes?: { id: number; subject: string; from: TaskStatus | null; to: TaskStatus }[];
  /** v1.0.37 (#45, engine v1.4.46): field-level diff of the affected task —
   *  "pending => pending" said nothing about WHAT changed; these lines are
   *  the WHAT (subject/doneCheck/blockedBy/verify/…, ~80 chars, max 6). */
  fields?: { field: string; from?: string | null; to: string }[];
  /** v1.0.55 (#83, engine v1.4.86): judge verdict for the affected task —
   *  renders as a ⚖ badge line; absent when no judge/audit state exists. */
  judge?: { verdict: string | null; rounds: number; failStreak: number; summary: string };
};

const marker = {
  completed: "✓",
  in_progress: "▶",
  pending: "·",
  held: "⚖", // v1.0.47 #64: judge holds completion — awaiting evidence
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
    held: c.statusWarning,
    cancelled: c.foregroundMuted,
    parked: c.statusWarning,
  } as const;
  const hasDiff = Array.isArray(d.changes) && d.changes.length > 0 && d.tool !== "task_list";
  const j = d.judge;
  const jTone = !j ? null : j.verdict === "pass" ? c.statusSuccess : j.verdict === "held" || j.verdict === "fail" ? c.statusWarning : c.foregroundMuted;

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
                {/* v1.0.46 (#64): when status is unchanged the "pending → pending" arrow reads as
                    a no-op/reverted — the headline is WHAT changed (verify/judge metadata). */}
                {ch.from && ch.from !== ch.to
                  ? `${ch.from} → ${ch.to}`
                  : `⚙ ${d.fields?.[0] ? d.fields[0].field : "metadata"}`}
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

      {/* #45: WHAT changed per field — muted monospace; doneCheck rewrites
          (model-side amendments) highlight warning like the panel trail. */}
      {hasDiff && d.fields && d.fields.length > 0 ? (
        <View style={{ gap: 1, paddingLeft: 22 }}>
          {d.fields.map((f, i) => (
            <Text
              key={i}
              style={{
                color: f.field.startsWith("doneCheck") ? c.statusWarning : c.foregroundMuted,
                fontFamily: "monospace",
                fontSize: 10,
                opacity: 0.9,
              }}
            >
              {`${f.field}: ${f.from ? `${f.from} → ` : ""}${f.to}`}
            </Text>
          ))}
        </View>
      ) : null}

      {j ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 22 }}>
          <Text style={{ color: jTone ?? c.foregroundMuted, fontSize: 11 }}>⚖</Text>
          <Text style={{ color: jTone ?? c.foregroundMuted, fontSize: 11, fontFamily: "monospace" }}>
            {`judge ${j.verdict ?? "pending"}${j.rounds > 0 ? ` · round ${j.rounds}` : ""}${j.failStreak > 0 ? ` · fail-streak ${j.failStreak}/2` : ""}`}
          </Text>
          {j.summary ? (
            <Text style={{ color: c.foregroundMuted, fontSize: 10, flex: 1 }} numberOfLines={1} ellipsizeMode="tail">
              {j.summary}
            </Text>
          ) : null}
        </View>
      ) : null}

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
