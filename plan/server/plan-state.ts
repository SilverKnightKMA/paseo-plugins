import os from "node:os";
import path from "node:path";
import { readFile, readdir, mkdir, writeFile, rename, stat } from "node:fs/promises";
import type { RpcInput } from "@getpaseo/plugin";
import {
  GetPlanStateRpc,
  ListPlanSessionsRpc,
  SetPlanControlRpc,
  type PlanPanelState,
  type PlanSessionBrief,
} from "../shared/rpc.js";

/**
 * v1.0.43 (#62): plan-mode projection reader + control writer, tách khỏi task
 * plugin. Engine read-only-mode (v1.4.46+) viết
 * ~/.pi/agent/plan-control/<sessionId>.status.json mỗi khi plan đổi trạng
 * thái và watch <sessionId>.json cho user action. Module này chỉ presentation:
 * đọc status, ghi control file, không bao giờ tự đổi plan state (single
 * writer = engine).
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

const MODES = ["inactive", "active", "awaiting", "tracking", "complete"] as const;
type Mode = (typeof MODES)[number];

function controlDir(): string {
  return path.join(process.env.HOME ?? os.homedir(), ".pi", "agent", "plan-control");
}

function asMode(v: unknown): Mode | null {
  return typeof v === "string" && (MODES as readonly string[]).includes(v) ? (v as Mode) : null;
}

export async function readPlanState(input: RpcInput<typeof GetPlanStateRpc>): Promise<PlanPanelState> {
  const file = path.join(controlDir(), `${input.sessionId}.status.json`);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return { ...EMPTY }; // engine chưa viết — session chạy ext cũ hoặc chưa dùng plan
  }
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    const mode = asMode(p.mode);
    if (!mode) return { ...EMPTY };
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
    return { ...EMPTY }; // torn read — atomic rename làm chuyện này hiếm
  }
}

/** Mọi session có status file, mới nhất trước — panel dùng cho chips. */
export async function listPlanSessions(): Promise<PlanSessionBrief[]> {
  const dir = controlDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: (PlanSessionBrief & { mtime: number })[] = [];
  for (const name of entries) {
    if (!name.endsWith(".status.json")) continue;
    const full = path.join(dir, name);
    try {
      const [raw, st] = await Promise.all([readFile(full, "utf8"), stat(full)]);
      const p = JSON.parse(raw) as Record<string, unknown>;
      const mode = asMode(p.mode);
      if (!mode || mode === "inactive") continue;
      out.push({
        sessionId: name.slice(0, -".status.json".length),
        mode,
        stepsDone: typeof p.stepsDone === "number" ? p.stepsDone : 0,
        stepsTotal: typeof p.stepsTotal === "number" ? p.stepsTotal : 0,
        updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : null,
        mtime: st.mtimeMs,
      });
    } catch {
      // torn/deleted — skip
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.map(({ mtime: _mtime, ...brief }) => brief);
}

export async function writePlanControl(
  input: RpcInput<typeof SetPlanControlRpc>,
): Promise<{ ok: boolean; sentAt: string; note?: string | null }> {
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
