import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";

/**
 * v2 (2026-09-05): session-first. The panel shows ONE workspace at a time —
 * the one it was opened in — resolved to the ACTIVE session (the chat that
 * is live now) via agent runtimeInfo, exactly like om-status. An explicit
 * input.sessionId lets the switcher inspect older sessions; the session
 * list + active marker come back for tracking.
 */
export const TopicFileSchema = z.object({
  file: z.string(),
  kb: z.number(),
  modified: z.string(),
});

export const SessionDetailSchema = z.object({
  sessionId: z.string(),
  topicFiles: z.number(),
  totalKb: z.number(),
  lastModified: z.string().nullable(),
  indexHead: z.array(z.string()),
  topics: z.array(TopicFileSchema),
});

export const SessionBriefSchema = z.object({
  sessionId: z.string(),
  topicFiles: z.number(),
  totalKb: z.number(),
  lastModified: z.string().nullable(),
  active: z.boolean(),
});

export const GetOmStateRpc = defineRpc({
  name: "om-panel.get-state",
  input: z.object({
    workspaceId: z.string(),
    /** null = resolve the workspace's active agent → its pi sessionId */
    agentId: z.string().nullish(),
    /** explicit override from the session switcher */
    sessionId: z.string().nullish(),
    indexLines: z.number().int().min(0).max(40).default(12),
  }),
  output: z.object({
    present: z.boolean(),
    workspace: z.string().nullable(),
    /** resolution chain result — what "the current session" means right now */
    resolved: z
      .object({
        sessionId: z.string(),
        agentId: z.string().nullable(),
        agentTitle: z.string().nullable(),
        via: z.enum(["explicit", "agent", "workspace-active", "newest"]),
      })
      .nullish(),
    session: SessionDetailSchema.nullish(),
    sessions: z.array(SessionBriefSchema).default([]),
    note: z.string().nullish(),
    generatedAt: z.string(),
  }),
});

export type OmPanelState = z.infer<typeof GetOmStateRpc.output>;
export type SessionDetail = z.infer<typeof SessionDetailSchema>;
export type SessionBrief = z.infer<typeof SessionBriefSchema>;
