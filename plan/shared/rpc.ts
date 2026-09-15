import { z } from "zod";

/**
 * v1.0.45 (#62): the plan plugin SHARES its session filter with task/snip — the RPC
 * shape mirrors GetTaskStateRpc (workspaceId + optional sessionId/agentId,
 * returns session chips filtered through the shared session-filter.ts). Projection source:
 * ~/.pi/agent/plan-control/<sessionId>.status.json (engine v1.4.46+; v1.4.62
 * adds steps intact). The control file is the USER-ONLY door (approve/revise/off).
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
    /** v1.4.62 (#62): the full step list intact — a checklist like task rows. */
    steps: z.array(z.object({
      index: z.number(),
      text: z.string(),
      done: z.boolean(),
      /** v1.0.54 (engine v1.4.68 #47 Phase B): the step-task backing this step
       *  on the task board — drives ✓/⚖/▸ glyphs; absent on unbridged plans. */
      taskRef: z.object({ id: z.number(), status: z.string() }).nullish(),
    })),
    currentStep: z.object({ index: z.number(), text: z.string() }).nullable(),
    planFile: z.string().nullable(),
    submittedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    /** v1.4.67 (#47 Phase A): full plan content (≤12KB) in awaiting mode — the USER reads + approves on the card. */
    planText: z.string().nullish(),
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
