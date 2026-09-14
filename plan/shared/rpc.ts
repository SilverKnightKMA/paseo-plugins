import { z } from "zod";

/**
 * v1.0.45 (#62): plan plugin dùng CHUNG session filter với task/snip — RPC
 * hình dạng giống GetTaskStateRpc (workspaceId + sessionId/agentId optional,
 * trả sessions chips đã lọc qua session-filter.ts shared). Projection nguồn:
 * ~/.pi/agent/plan-control/<sessionId>.status.json (engine v1.4.46+; v1.4.62
 * thêm steps nguyên vẹn). Control file là cửa USER-ONLY (approve/revise/off).
 */
export const GetPlanStateRpc = {
  name: "plan.get-state",
  input: z.object({
    workspaceId: z.string(),
    sessionId: z.string().nullish(),
    agentId: z.string().nullish(),
  }),
  output: z.object({
    present: z.boolean(),
    sessionId: z.string().nullable(),
    resolved: z
      .object({
        agentId: z.string().nullable(),
        agentTitle: z.string().nullable(),
        sessionId: z.string(),
        via: z.enum(["explicit", "agent", "workspace-active"]),
      })
      .nullish(),
    sessions: z.array(
      z.object({
        sessionId: z.string(),
        title: z.string().nullable(),
        active: z.boolean(),
        engineLive: z.boolean(),
      }),
    ),
    mode: z.enum(["inactive", "active", "awaiting", "tracking", "complete"]).nullable(),
    stepsDone: z.number().nullable(),
    stepsTotal: z.number().nullable(),
    /** v1.4.62 (#62): danh sách bước nguyên vẹn — checklist như task rows. */
    steps: z.array(z.object({ index: z.number(), text: z.string(), done: z.boolean() })),
    currentStep: z.object({ index: z.number(), text: z.string() }).nullable(),
    planFile: z.string().nullable(),
    submittedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
    note: z.string().nullish(),
  }),
};

export type PlanPanelState = z.infer<typeof GetPlanStateRpc.output>;

export const SetPlanControlRpc = {
  name: "plan.set-control",
  input: z.object({
    sessionId: z.string(),
    action: z.enum(["on", "approve", "revise", "off"]),
  }),
  output: z.object({
    ok: z.boolean(),
    sentAt: z.string(),
    note: z.string().nullish(),
  }),
};
