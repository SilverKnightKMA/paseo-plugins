import { z } from "zod";

/**
 * v1.0.43 (#62): tách plan khỏi task panel — plugin riêng cho plan-mode.
 * Projection nguồn: ~/.pi/agent/plan-control/<sessionId>.status.json do
 * engine read-only-mode viết (v1.4.46+; v1.4.60 thêm mode "complete" +
 * currentStep). Control file ~/.pi/agent/plan-control/<sessionId>.json là
 * cửa USER-ONLY (approve/revise/off) — model không thể tự duyệt plan.
 */
export const GetPlanStateRpc = {
  name: "plan.get-state",
  input: z.object({
    sessionId: z.string(),
  }),
  output: z.object({
    present: z.boolean(),
    mode: z.enum(["inactive", "active", "awaiting", "tracking", "complete"]).nullable(),
    stepsDone: z.number().nullable(),
    stepsTotal: z.number().nullable(),
    /** v1.4.60 (#62): plan đang làm gì — bước mở đầu tiên. */
    currentStep: z.object({ index: z.number(), text: z.string() }).nullable(),
    planFile: z.string().nullable(),
    submittedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
  }),
};

/** Quét mọi session có plan status trong control dir — panel tự chọn session. */
export const ListPlanSessionsRpc = {
  name: "plan.list-sessions",
  input: z.object({}),
  output: z.object({
    sessions: z.array(
      z.object({
        sessionId: z.string(),
        mode: z.enum(["inactive", "active", "awaiting", "tracking", "complete"]),
        stepsDone: z.number(),
        stepsTotal: z.number(),
        updatedAt: z.string().nullable(),
      }),
    ),
  }),
};

export type PlanPanelState = z.infer<typeof GetPlanStateRpc.output>;
export type PlanSessionBrief = z.infer<typeof ListPlanSessionsRpc.output>["sessions"][number];

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
