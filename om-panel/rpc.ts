import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";

export const WorkspaceMemorySchema = z.object({
  workspace: z.string(),
  sessions: z.array(
    z.object({
      sessionId: z.string(),
      topicFiles: z.number(),
      totalKb: z.number(),
      lastModified: z.string().nullable(),
      indexHead: z.array(z.string()),
    }),
  ),
});

export const GetOmStateRpc = defineRpc({
  name: "om-panel.get-state",
  input: z
    .object({
      cwd: z.string().optional(),
      indexLines: z.number().int().min(0).max(40).default(12),
    })
    .default({ indexLines: 12 }),
  output: z.object({
    workspaces: z.array(WorkspaceMemorySchema),
    generatedAt: z.string(),
  }),
});

export type OmPanelState = z.infer<typeof GetOmStateRpc.output>;
