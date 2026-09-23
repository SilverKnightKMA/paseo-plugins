import { z } from "zod";

export const OmEventSchema = z.object({
  ts: z.string(),
  text: z.string(),
});

export const OmSummarySchema = z.object({
  verdict: z.enum(["working", "warning", "healthy"]),
  observersRunning: z.number(),
  observerSlots: z.number(),
  consolidatorRunning: z.boolean(),
  contextTokens: z.number().nullable(),
  contextMax: z.number(),
  poolTokens: z.number(),
  poolMax: z.number(),
  sessionCostUsd: z.number(),
  sessionRuns: z.number(),
  // #100 (v1.0.75): role split + storage/GC — defaults keep OLD projections parsing
  observerCostUsd: z.number().default(0),
  observerRuns: z.number().default(0),
  consolidatorCostUsd: z.number().default(0),
  consolidatorRuns: z.number().default(0),
  rollupFiles: z.number().default(0),
  rollupCostUsd: z.number().default(0),
  runsCostTtlDays: z.number().default(0),
  lastRunsGcDay: z.string().default(""),
});

/**
 * Session resolution is agent-driven, never file-mtime-driven:
 *  - agentId given (pill / timeline card): that agent's runtimeInfo.sessionId
 *  - workspace only (panel): the workspace's ACTIVE agent — status "running"
 *    first, else the most recently updated — then its sessionId
 * The file read is then EXACT: .memory/<sessionId>/om-status.json. No race
 * between concurrent sessions; unresolvable (agent initializing) is an
 * honest present:false instead of a heuristic guess.
 */
export const GetOmStatusRpc = {
  name: "om-status.read",
  input: z.object({
    workspaceId: z.string(),
    agentId: z.string().nullish(),
    /** explicit override from the chips picker — beats every resolution */
    sessionId: z.string().nullish(),
  }),
  output: z.object({
    present: z.boolean(),
    generatedAt: z.string().nullable(),
    enabled: z.boolean().nullable(),
    sessionId: z.string().nullable(),
    workspace: z.string().nullable(),
    lines: z.array(z.string()),
    summary: OmSummarySchema.nullable(),
    events: z.array(OmEventSchema),
    ageSec: z.number().nullable(),
    sessions: z
      .array(
        z.object({
          sessionId: z.string(),
          ageSec: z.number(),
          title: z.string().nullable(),
          /** chip sync with om-panel: .md topic count (minus INDEX.md) + active marker */
          topicFiles: z.number(),
          active: z.boolean(),
        }),
      )
      .default([]),
    resolved: z
      .object({
        agentId: z.string().nullable(),
        agentTitle: z.string().nullable(),
        sessionId: z.string(),
        status: z.string().nullable(),
        via: z.enum(["agent", "workspace-active", "explicit"]),
      })
      .nullish(),
    note: z.string().nullish(),
  }),
};

export type OmStatusState = z.infer<typeof GetOmStatusRpc.output>;

/**
 * #244 (M3, v1.0.94): OM Topics — read-only listing of a session's topic
 * files (.memory/<sessionId>/*.md minus INDEX.md) with head observations.
 * On-demand only (never part of the live poll); the panel fetches when the
 * Topics segment/pill is opened.
 */
export const OmTopicSchema = z.object({
  name: z.string(),
  sizeBytes: z.number(),
  updatedAt: z.string(),
  /** first observation lines (≤5, 200 chars each) — the preview in the list */
  head: z.array(z.string()).default([]),
});

export const GetOmTopicsRpc = {
  name: "om-status.topics",
  input: z.object({
    workspaceId: z.string(),
    /** explicit session — the panel always knows it from the status resolution */
    sessionId: z.string(),
  }),
  output: z.object({
    present: z.boolean(),
    sessionId: z.string().nullable(),
    topics: z.array(OmTopicSchema).default([]),
    note: z.string().nullish(),
  }),
};

export type OmTopic = z.infer<typeof OmTopicSchema>;
export type OmTopicsState = z.infer<typeof GetOmTopicsRpc.output>;
