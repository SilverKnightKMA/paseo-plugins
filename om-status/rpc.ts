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
 * Resolves the NEWEST .memory/<sessionId>/om-status.json in the workspace —
 * several chats may run OM concurrently, each writing its own file; the most
 * recently active session is what "the" status means. Falls back to the
 * pre-v1.2.4 workspace-level path during the transition.
 */
export const GetOmStatusRpc = {
  name: "om-status.read",
  input: z.object({
    workspaceId: z.string(),
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
  }),
};

export type OmStatusState = z.infer<typeof GetOmStatusRpc.output>;
