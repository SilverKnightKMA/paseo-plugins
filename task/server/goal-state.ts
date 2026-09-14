import os from "node:os";
import path from "node:path";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import type { RpcInput } from "@getpaseo/plugin";
import { GetGoalStateRpc, SetGoalControlRpc, type GoalPanelState } from "../shared/rpc.js";

/**
 * #37 (engine v1.4.52): goal projection reader + control writer — mirror của
 * plan-state.ts. Engine goal ext ghi ~/.pi/agent/goal-status/<sessionId>.json
 * và watch goal-control/<sessionId>.json (confirm/revise/cancel, user-only).
 */
const EMPTY: GoalPanelState = {
  present: false,
  goalId: null,
  status: null,
  anchor: null,
  epoch: null,
  members: null,
  leaseUsed: null,
  proposal: null,
  updatedAt: null,
};

function statusDir(): string {
  return path.join(process.env.HOME ?? os.homedir(), ".pi", "agent", "goal-status");
}
function controlDir(): string {
  return path.join(process.env.HOME ?? os.homedir(), ".pi", "agent", "goal-control");
}

export async function readGoalState(input: RpcInput<typeof GetGoalStateRpc>): Promise<GoalPanelState> {
  const file = path.join(statusDir(), `${input.sessionId}.json`);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return { ...EMPTY };
  }
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    const status = typeof p.status === "string" ? p.status : null;
    if (!status || status === "stopped" || status === "done") {
      return { ...EMPTY, present: true, status };
    }
    const pr = p.proposal as Record<string, unknown> | undefined;
    const lease = p.lease as Record<string, unknown> | undefined;
    return {
      present: true,
      goalId: typeof p.goalId === "string" ? p.goalId : null,
      status,
      anchor: typeof p.anchor === "string" ? p.anchor : null,
      epoch: typeof p.epoch === "number" ? p.epoch : null,
      members: Array.isArray(p.members) ? (p.members as number[]).length : null,
      leaseUsed: lease && typeof lease.used === "boolean" ? lease.used : null,
      proposal:
        pr && typeof pr === "object" && typeof pr.anchor === "string"
          ? {
              anchor: pr.anchor,
              includeIds: Array.isArray(pr.includeIds) ? (pr.includeIds as number[]) : [],
              excludeIds: Array.isArray(pr.excludeIds) ? (pr.excludeIds as number[]) : [],
              rationale: typeof pr.rationale === "string" ? pr.rationale : "",
            }
          : null,
      updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : null,
    };
  } catch {
    return { ...EMPTY };
  }
}

export async function writeGoalControl(
  input: RpcInput<typeof SetGoalControlRpc>,
): Promise<{ ok: boolean; sentAt: string; note: string | null }> {
  const dir = controlDir();
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${input.sessionId}.json`);
  const sentAt = new Date().toISOString();
  const payload = { v: 1, action: input.action, sentAt };
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(payload), "utf8");
  await rename(tmp, file);
  return { ok: true, sentAt, note: "engine áp trong ~1s — panel tự refresh qua ack" };
}
