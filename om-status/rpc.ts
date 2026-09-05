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
    sessions: z.array(z.object({ sessionId: z.string(), ageSec: z.number() })).default([]),
    resolved: z
      .object({
        agentId: z.string().nullable(),
        sessionId: z.string(),
        status: z.string().nullable(),
        via: z.enum(["agent", "workspace-active"]),
      })
      .nullish(),
    note: z.string().nullish(),
  }),
};

export type OmStatusState = z.infer<typeof GetOmStatusRpc.output>;
