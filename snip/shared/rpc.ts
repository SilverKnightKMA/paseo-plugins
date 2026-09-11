import { z } from "zod";

export const SnippetBriefSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  placement: z.enum(["prepend", "append"]),
  order: z.number(),
});

/**
 * Session resolution mirrors om-status: explicit (chips picker) > agentId
 * (pill) > workspace-active agent. The engine side (pi extension snip v1.5)
 * watches ~/.pi/agent/snip-control/<sessionId>.json and acks every request by
 * rewriting the file with ackAt — engineLive is "the engine process for this
 * session has written the file at least once".
 */
export const GetSnipStateRpc = {
  name: "snip.get-state",
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
    /** ids of active snippets, as last acked by the engine */
    active: z.array(z.string()),
    sticky: z.boolean(),
    sentAt: z.string().nullable(),
    ackAt: z.string().nullable(),
    ackAgeSec: z.number().nullable(),
    /** engine wrote the control file at least once (session loaded snip v1.5+) */
    engineLive: z.boolean(),
    snippets: z.array(SnippetBriefSchema).default([]),
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

export const SetSnipStateRpc = {
  name: "snip.set-state",
  input: z.object({
    workspaceId: z.string(),
    sessionId: z.string(),
    active: z.array(z.string()),
    sticky: z.boolean(),
  }),
  output: z.object({
    ok: z.boolean(),
    /** the engine acks by rewriting the file with ackAt >= sentAt */
    sentAt: z.string(),
    note: z.string().nullish(),
  }),
};

export type SnipState = z.infer<typeof GetSnipStateRpc.output>;
