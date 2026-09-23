import type { PluginClientContext } from "@getpaseo/plugin/client";
import { z } from "zod";
import { TaskPanel } from "./client/panel.js";
import { startTaskLive } from "./client/pill.js";
import { TaskSnapshotCard } from "./client/snapshot.js";

export default function contribute(client: PluginClientContext) {
  // #244 (v1.0.94, spec M1): fragment-level guards — one failing registration
  // must not abort the whole contribute() (F9 lesson: a throw kills everything after it).
  const guard = <T,>(tag: string, fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (err) {
      console.error(`[task] ${tag} failed:`, err);
      return undefined;
    }
  };

  guard("addWorkspacePanel", () =>
    client.addWorkspacePanel({
      id: "task",
      title: "Tasks",
      icon: "ListTodo",
      context: "workspace",
      Component: TaskPanel,
    }),
  );

  guard("addCommandCenterItem", () =>
    client.addCommandCenterItem({
      id: "task-open",
      title: "Tasks: session task list (read-only)",
      icon: "ListTodo",
      keywords: ["task", "tasks", "todo", "progress"],
      context: "workspace",
      onSelect(context_) {
        context_.openPanel("task");
      },
    }),
  );

  // Composer pill: done/total gauge next to the agent badge, model-invisible
  // by construction (client render layer only, never in pi's state.messages).
  const stopPill = startTaskLive(client);

  // ── In-flow task checklist cards (v1.0.26) ────────────────────────────
  // The pi task extension (≥ v1.4.23) rides a full task snapshot in every
  // task_* tool result's `details` (model-invisible metadata). The
  // transformer parses it and replaces the raw tool-call entry with a
  // versioned plugin card — the maintainer-blessed pattern from the official
  // pi-tasks timeline example (getpaseo/paseo PR #3940; native mapping was
  // closed not-planned in #3121). Sessions on older ext code (no
  // details.tasks) fall through untouched. Render-layer only: the transcript
  // tool result stays intact for the model.
  const taskToolNames = new Set(["task_create", "task_update", "task_list"]);
  const snapshotTasksSchema = z.array(
    z.object({
      id: z.number().int(),
      subject: z.string(),
      status: z.enum(["pending", "in_progress", "completed", "cancelled", "parked"]),
    }),
  );
  // v1.0.32: optional prev→next diff for the affected task (absent on task_list
  // and on older engine builds — both render the full checklist as before).
  const snapshotChangesSchema = z.array(
    z.object({
      id: z.number().int(),
      subject: z.string(),
      from: z.enum(["pending", "in_progress", "completed", "cancelled", "parked"]).nullable(),
      to: z.enum(["pending", "in_progress", "completed", "cancelled", "parked"]),
    }),
  );

  // v1.0.37 (#45): field-level diff lines for the affected task (absent on
  // older engine builds — card renders exactly as before).
  const snapshotFieldsSchema = z.array(
    z.object({
      field: z.string(),
      from: z.string().nullable().optional(),
      to: z.string(),
    }),
  );

  // v1.0.55 (#83, engine v1.4.86): judge verdict chip data — present only when
  // the task_update carried an audit/judge state (older engines fall through).
  const snapshotJudgeSchema = z.object({
    verdict: z.string().nullable(),
    rounds: z.number(),
    failStreak: z.number(),
    summary: z.string(),
  });

  guard("addTimelineTransformer", () =>
    client.addTimelineTransformer({
      id: "task-snapshot-transformer",
      query: { itemType: "tool_call" },
    transform: ({ item }) => {
      const it = item as { type?: string; name?: unknown; detail?: unknown };
      if (it.type !== "tool_call") return undefined;
      if (typeof it.name !== "string" || !taskToolNames.has(it.name)) return undefined;
      const detail = it.detail as { output?: unknown } | undefined;
      if (!detail || typeof detail.output !== "object" || detail.output === null) return undefined;
      const details = Reflect.get(detail.output as Record<string, unknown>, "details");
      if (!details || typeof details !== "object") return undefined;
      const tasks = snapshotTasksSchema.safeParse(Reflect.get(details as Record<string, unknown>, "tasks"));
      if (!tasks.success || tasks.data.length === 0) return undefined;
      const changesParsed = snapshotChangesSchema.safeParse(Reflect.get(details as Record<string, unknown>, "changes"));
      const fieldsParsed = snapshotFieldsSchema.safeParse(Reflect.get(details as Record<string, unknown>, "fields"));
      const judgeParsed = snapshotJudgeSchema.safeParse(Reflect.get(details as Record<string, unknown>, "judge"));
      return {
        items: [
          {
            type: "plugin" as const,
            kind: "task-snapshot",
            version: 1,
            data: {
              tool: it.name as "task_create" | "task_update" | "task_list",
              tasks: tasks.data,
              ...(changesParsed.success && changesParsed.data.length > 0 ? { changes: changesParsed.data } : {}),
              ...(fieldsParsed.success && fieldsParsed.data.length > 0 ? { fields: fieldsParsed.data } : {}),
              ...(judgeParsed.success ? { judge: judgeParsed.data } : {}),
            },
          },
        ],
      };
    },
  }));

  // Doorbell wake-signal items (server/doorbell-server.ts, kind "doorbell" v1)
  // are renderer-less BY DESIGN — invisible wake pings, not content. App 0.8.0
  // shows "Plugin timeline item unavailable." for plugin items whose owning
  // plugin registers no renderer — register a null renderer so bells stay
  // invisible on the canonical/history path too (2026-09-22 UI audit).
  guard("addTimelineRenderer(doorbell)", () =>
    client.addTimelineRenderer({
      kind: "doorbell",
      version: 1,
      schema: z.object({ bell: z.string(), file: z.string(), ts: z.string() }),
      Component: () => null,
    }),
  );

  guard("addTimelineRenderer(task-snapshot)", () =>
    client.addTimelineRenderer({
      kind: "task-snapshot",
      version: 1,
      schema: z.object({
        tool: z.enum(["task_create", "task_update", "task_list"]),
        tasks: snapshotTasksSchema,
        changes: snapshotChangesSchema.optional(),
        fields: snapshotFieldsSchema.optional(),
        judge: snapshotJudgeSchema.optional(),
      }),
      Component: TaskSnapshotCard,
    }),
  );

  return () => {
    stopPill();
  };
}
