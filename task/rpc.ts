import { z } from "zod";

export const TaskBriefSchema = z.object({
  id: z.number(),
  subject: z.string(),
  description: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
  evidence: z.string().nullable(),
  blockedBy: z.array(z.number()),
  blocks: z.array(z.number()),
  updatedAt: z.number(),
});

/**
 * READ-ONLY presentation of the pi task extension's status-file projection
 * (~/.pi/agent/task-status/<sessionId>.json, written by pi-config v1.4.21+).
 * No set RPC on purpose: task state changes only through the model's
 * task_create/task_update tools — the engine is the single writer, this
 * plugin is presentation (same doctrine as om-status).
 *
 * Session resolution mirrors snip/om-status: explicit (chips picker) >
 * agentId (pill) > workspace-active main chat.
 */
export const GetTaskStateRpc = {
  name: "task.get-state",
  input: z.object({
    workspaceId: z.string(),
    agentId: z.string().nullish(),
    /** explicit override from the chips picker — beats every resolution */
    sessionId: z.string().nullish(),
  }),
  output: z.object({
    present: z.boolean(),
    note: z.string().nullish(),
    sessionId: z.string().nullable(),
    /** engine wrote the projection at least once (session loaded task v1.4.21+) */
    engineLive: z.boolean(),
    writtenAt: z.string().nullable(),
    total: z.number(),
    done: z.number(),
    inProgress: z.number(),
    pending: z.number(),
    cancelled: z.number(),
    /** ids with no open blockers and still pending — safe to parallelize */
    ready: z.array(z.number()),
    tasks: z.array(TaskBriefSchema).default([]),
    sessions: z
      .array(
        z.object({
          sessionId: z.string(),
          title: z.string().nullable(),
          active: z.boolean(),
          engineLive: z.boolean(),
        }),
      )
      .default([]),
    resolved: z
      .object({
        agentId: z.string().nullable(),
        agentTitle: z.string().nullable(),
        sessionId: z.string(),
        via: z.enum(["agent", "workspace-active", "explicit"]),
      })
      .nullish(),
  }),
};

export type TaskPanelState = z.infer<typeof GetTaskStateRpc.output>;
