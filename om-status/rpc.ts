import { z } from "zod";

export const OmEventSchema = z.object({
  ts: z.string(),
  text: z.string(),
});

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
    events: z.array(OmEventSchema),
    ageSec: z.number().nullable(),
  }),
};

export type OmStatusState = z.infer<typeof GetOmStatusRpc.output>;
