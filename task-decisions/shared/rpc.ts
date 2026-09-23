import { z } from "zod";

/**
 * #240 (P1, task-decisions plugin v1.0.0): panel cards for the engine's
 * decisions artifact (~/.pi/agent/task-status/<sid>.decisions.json, written
 * by the pi task extension ≥ v1.4.135) + the buttons that decide them via
 * the USER-ONLY control-file bridge (~/.pi/agent/task-control/<sid>.json).
 *
 * The plugin never decides anything by itself — buttons WRITE the control
 * file (disk is truth) and poke the engine bell; the engine applies, stamps
 * decidedAt/decision and notifies the model ([task-decision] followUp).
 */

export const DecisionEntrySchema = z.object({
  id: z.string(), // d-<n>
  taskId: z.number(),
  kind: z.enum(["amend", "cancel-proposal", "appeal", "note"]),
  reason: z.string(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decision: z.enum(["approved", "rejected"]).nullable(),
});

export const SessionDecisionsSchema = z.object({
  sessionId: z.string(),
  agentTitle: z.string().nullable(),
  /** subject/status for every task referenced by an entry (cards show them) */
  tasks: z.array(z.object({ id: z.number(), subject: z.string(), status: z.string() })).default([]),
  entries: z.array(DecisionEntrySchema).default([]),
});

export type DecisionEntry = z.infer<typeof DecisionEntrySchema>;
export type SessionDecisions = z.infer<typeof SessionDecisionsSchema>;

export const GetDecisionsRpc = {
  name: "task-decisions.read",
  input: z.object({
    workspaceId: z.string(),
    /** only undecided entries (default true) or the full audit trail */
    includeDecided: z.boolean().default(false),
  }),
  output: z.object({
    sessions: z.array(SessionDecisionsSchema).default([]),
    note: z.string().nullish(),
  }),
};

/** User pressed a button. The SERVER writes the control file (the client
 *  cannot touch disk) — engine verbs only, exactly the shapes control.ts
 *  parseControlPayload accepts (v1.4.135+: proposal-decide {dId}, cancel;
 *  plan-control {action:"on"}). */
export const PokeControlRpc = {
  name: "task-decisions.poke",
  input: z.object({
    sessionId: z.string(),
    action: z.enum(["proposal-decide", "cancel", "plan-on"]),
    /** task-control: the task the verb targets */
    taskId: z.number().nullish(),
    /** proposal-decide with dId */
    dId: z.string().nullish(),
    decision: z.enum(["approved", "rejected"]).nullish(),
  }),
  output: z.object({
    ok: z.boolean(),
    note: z.string(),
  }),
};
