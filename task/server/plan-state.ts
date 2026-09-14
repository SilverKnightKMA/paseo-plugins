import os from "node:os";
import path from "node:path";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import type { RpcInput } from "@getpaseo/plugin";
import { GetPlanStateRpc, SetPlanControlRpc, type PlanPanelState } from "../shared/rpc.js";

/**
 * #22 (engine v1.4.46): plan-mode projection reader + control writer.
 *
 * The pi read-only-mode extension (v1.4.46+) writes
 * ~/.pi/agent/plan-control/<sessionId>.status.json on every plan mutation
 * (persistPlan) and watches <sessionId>.json for user actions. This module
 * is presentation-side only: read the status, write the control file, never
 * touch plan state directly — the engine is the single writer (task-control
 * pattern, v1.0.31).
 */

const EMPTY: PlanPanelState = {
  present: false,
  mode: null,
  stepsDone: null,
  stepsTotal: null,
  currentStep: null,
  planFile: null,
  submittedAt: null,
  completedAt: null,
  updatedAt: null,
};

function controlDir(): string {
  return path.join(process.env.HOME ?? os.homedir(), ".pi", "agent", "plan-control");
}

export async function readPlanState(input: RpcInput<typeof GetPlanStateRpc>): Promise<PlanPanelState> {
  const file = path.join(controlDir(), `${input.sessionId}.status.json`);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return { ...EMPTY }; // engine never wrote — session on older ext or plan never used
  }
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    const mode = typeof p.mode === "string" ? p.mode : null;
    if (mode !== "inactive" && mode !== "active" && mode !== "awaiting" && mode !== "tracking" && mode !== "complete") {
      return { ...EMPTY };
    }
    const step =
      p.currentStep && typeof p.currentStep === "object" &&
      typeof (p.currentStep as { index?: unknown }).index === "number" &&
      typeof (p.currentStep as { text?: unknown }).text === "string"
        ? { index: (p.currentStep as { index: number }).index, text: (p.currentStep as { text: string }).text }
        : null;
    return {
      present: true,
      mode,
      stepsDone: typeof p.stepsDone === "number" ? p.stepsDone : 0,
      stepsTotal: typeof p.stepsTotal === "number" ? p.stepsTotal : 0,
      currentStep: step,
      planFile: typeof p.planFile === "string" ? p.planFile : null,
      submittedAt: typeof p.submittedAt === "string" ? p.submittedAt : null,
      completedAt: typeof p.completedAt === "string" ? p.completedAt : null,
      updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : null,
    };
  } catch {
    return { ...EMPTY }; // torn read — atomic rename makes this rare
  }
}

export async function writePlanControl(
  input: RpcInput<typeof SetPlanControlRpc>,
): Promise<{ ok: boolean; sentAt: string; note: string | null }> {
  const dir = controlDir();
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${input.sessionId}.json`);
  const sentAt = new Date().toISOString();
  const payload = { v: 1, action: input.action, sentAt };
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(payload), "utf8");
  await rename(tmp, file);
  return {
    ok: true,
    sentAt,
    note: "engine áp dụng trong ~1s — panel sẽ tự refresh (ack = engine online)",
  };
}
