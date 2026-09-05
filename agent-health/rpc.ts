import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";

export const AgentRowSchema = z.object({
  id: z.string(),
  status: z.string().nullable(),
  provider: z.string(),
  model: z.string().nullable(),
  cwd: z.string(),
});

export const StuckQueueSchema = z.object({
  agentId: z.string(),
  name: z.string().nullable(),
  events: z.number(),
  oldestEventIso: z.string(),
  ageHours: z.number(),
});

export const ZwEventSchema = z.object({
  ts: z.string(),
  code: z.string(),
  idleMs: z.number().nullable(),
  agentId: z.string().nullable(),
});

export const GetStateRpc = defineRpc({
  name: "agent-health.get-state",
  input: z
    .object({ limit: z.number().int().min(1).max(100).default(20) })
    .default({ limit: 20 }),
  output: z.object({
    agents: z.array(AgentRowSchema),
    zwEvents: z.array(ZwEventSchema),
    stuckQueues: z.array(StuckQueueSchema),
    zwCounts: z.record(z.string(), z.number()),
    generatedAt: z.string(),
  }),
});

export type AgentHealthState = z.infer<typeof GetStateRpc.output>;

export const GetZwAlertRpc = defineRpc({
  name: "agent-health.zw-alert",
  input: z.object({ agentId: z.string().optional() }).default({}),
  output: z.object({
    alert: z.boolean(),
    ts: z.string().nullable(),
    code: z.string().nullable(),
    idleMs: z.number().nullable(),
    agentId: z.string().nullable(),
    mine: z.boolean(),
  }),
});

export type ZwAlertState = z.infer<typeof GetZwAlertRpc.output>;
