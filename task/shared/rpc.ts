import { z } from "zod";

export const TaskBriefSchema = z.object({
  id: z.number(),
  subject: z.string(),
  description: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "cancelled", "parked"]),
  evidence: z.string().nullable(),
  blockedBy: z.array(z.number()),
  blocks: z.array(z.number()),
  updatedAt: z.number(),
  /** layer-2 (v1.4.26): judge counters + park reason — optional for older projections */
  failStreak: z.number().optional(),
  judgeRounds: z.number().optional(),
  appealReason: z.string().optional(),
  /** verify spec (projection v1.4.21+): powers the user STRICT toggle */
  verify: z
    .object({
      lane: z.enum(["state", "judgment"]),
      strict: z.boolean(),
      probeCount: z.number(),
    })
    .optional(),
  audit: z
    .object({ verdict: z.string(), summary: z.string() })
    .optional(),
  /** v1.0.35 doneCheck guard (engine v1.4.38): agent rewrites of the sheet
   * (cap 2) + the old→new trail the judge also sees. */
  descAmendments: z.number().optional(),
  descHistory: z
    .array(
      z.object({
        at: z.number(),
        by: z.enum(["agent", "user"]),
        from: z.string(),
        to: z.string(),
      }),
    )
    .optional(),
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

/**
 * USER-ONLY task actions via the control-file bridge (v1.4.28 engine / v1.0.31
 * plugin). The model may put a task INTO park (appeal, round cap) but only the
 * user surface may take it out; likewise lowering strict is user-only. This
 * RPC never touches task state directly — it writes
 * ~/.pi/agent/task-control/<sessionId>.json and the engine (single writer)
 * applies + acks it (snip bridge pattern).
 */
export const SetTaskControlRpc = {
  name: "task.set-control",
  input: z.object({
    workspaceId: z.string(),
    sessionId: z.string(),
    id: z.number().int().positive(),
    action: z.enum(["unpark", "strict", "reopen", "amend"]),
    /** strict only: target value (unpark ignores it) */
    value: z.boolean().nullish(),
    /** amend only (v1.0.35): the new done-check text, authored by the user. */
    description: z.string().nullish(),
  }),
  output: z.object({
    ok: z.boolean(),
    /** the engine acks by rewriting the file with ackAt >= sentAt */
    sentAt: z.string(),
    note: z.string().nullish(),
  }),
};
