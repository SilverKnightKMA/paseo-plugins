import os from "node:os";
import path from "node:path";
import { readFile, readdir, mkdir, writeFile, rename } from "node:fs/promises";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { GetPlanStateRpc, SetPlanControlRpc, type PlanPanelState } from "../shared/rpc.js";
import { mergeLiveTitles, titleFor } from "./titles.js";
import { isHiddenSession } from "./session-filter.js";

/**
 * v1.0.45 (#62): session resolution + filter dùng CHUNG semantics với task/snip
 * (session-filter.ts / titles.ts shared, pinned bởi check-shared-ui.py):
 * hide archived/subagent/internal; explicit chip > agentId (pill) >
 * workspace-active main chat. Engine read-only-mode là single writer của
 * ~/.pi/agent/plan-control/<sessionId>.status.json; module này chỉ đọc +
 * ghi control file cho user action.
 */

const EMPTY: PlanPanelState = {
  present: false,
  sessionId: null,
  resolved: undefined,
  sessions: [],
  mode: null,
  stepsDone: null,
  stepsTotal: null,
  steps: [],
  currentStep: null,
  planFile: null,
  submittedAt: null,
  completedAt: null,
  updatedAt: null,
  note: null,
};

const MODES = ["inactive", "active", "awaiting", "tracking", "complete"] as const;
type Mode = (typeof MODES)[number];

function controlDir(): string {
  return path.join(process.env.HOME ?? os.homedir(), ".pi", "agent", "plan-control");
}

function asMode(v: unknown): Mode | null {
  return typeof v === "string" && (MODES as readonly string[]).includes(v) ? (v as Mode) : null;
}

// session visibility lives in ./session-filter.js (shared, pinned by check-shared-ui.py)
type AgentLike = {
  id?: unknown;
  title?: unknown;
  workspaceId?: unknown;
  cwd?: unknown;
  status?: unknown;
  lastUserMessageAt?: unknown;
  updatedAt?: unknown;
  runtimeInfo?: { sessionId?: unknown } | null;
};

function unwrapAgents(entries: unknown[]): AgentLike[] {
  const out: AgentLike[] = [];
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const a = e as Record<string, unknown>;
    if (typeof a.id === "string" && a.id) out.push(e as AgentLike);
  }
  return out;
}

async function listSessionFiles(): Promise<string[]> {
  try {
    const files = await readdir(controlDir());
    return files.filter((f) => f.endsWith(".status.json")).map((f) => f.replace(/\.status\.json$/, ""));
  } catch {
    return [];
  }
}

async function readStatus(sessionId: string): Promise<PlanPanelState | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(controlDir(), `${sessionId}.status.json`), "utf8");
  } catch {
    return null; // engine chưa viết — session chạy ext cũ hoặc chưa dùng plan
  }
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    const mode = asMode(p.mode);
    if (!mode) return null;
    const step =
      p.currentStep && typeof p.currentStep === "object" &&
      typeof (p.currentStep as { index?: unknown }).index === "number" &&
      typeof (p.currentStep as { text?: unknown }).text === "string"
        ? { index: (p.currentStep as { index: number }).index, text: (p.currentStep as { text: string }).text }
        : null;
    const steps = Array.isArray(p.steps)
      ? p.steps
          .filter(
            (s): s is { index: number; text: string; done: boolean } =>
              !!s && typeof s === "object" &&
              typeof (s as { index?: unknown }).index === "number" &&
              typeof (s as { text?: unknown }).text === "string" &&
              typeof (s as { done?: unknown }).done === "boolean",
          )
          .map((s) => ({ index: s.index, text: s.text, done: s.done }))
      : [];
    return {
      ...EMPTY,
      present: true,
      mode,
      stepsDone: typeof p.stepsDone === "number" ? p.stepsDone : 0,
      stepsTotal: typeof p.stepsTotal === "number" ? p.stepsTotal : 0,
      steps,
      currentStep: step,
      planFile: typeof p.planFile === "string" ? p.planFile : null,
      submittedAt: typeof p.submittedAt === "string" ? p.submittedAt : null,
      completedAt: typeof p.completedAt === "string" ? p.completedAt : null,
      updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : null,
    };
  } catch {
    return null; // torn read — atomic rename làm chuyện này hiếm
  }
}

export async function readPlanState(
  input: RpcInput<typeof GetPlanStateRpc>,
  context: PluginHandlerContext,
): Promise<PlanPanelState> {
  try {
    let agents: AgentLike[] = [];
    try {
      agents = unwrapAgents((await context.paseo.agents.list()).entries);
    } catch {
      agents = [];
    }
    const titleBySession = new Map<string, string>();
    for (const a of agents) {
      const sid = a.runtimeInfo?.sessionId;
      if (typeof sid === "string" && sid && typeof a.title === "string") titleBySession.set(sid, a.title);
    }

    let rootDir: string | null = null;
    try {
      const ws = await context.paseo.workspaces.list();
      const hit = ws.entries.find((w) => w.id === input.workspaceId);
      rootDir = hit?.projectRootPath ?? null;
    } catch {
      // workspaces unavailable
    }
    const inWsAgent = (a: AgentLike): boolean => {
      if (typeof a.workspaceId === "string" && a.workspaceId) return a.workspaceId === input.workspaceId;
      return rootDir != null && typeof a.cwd === "string" && a.cwd === rootDir;
    };

    // 1) resolution: explicit (chips) > agentId (pill) > workspace-active main chat
    let resolved: PlanPanelState["resolved"] = undefined;
    if (input.sessionId) {
      const agent = agents.find((a) => a.runtimeInfo?.sessionId === input.sessionId);
      resolved = { agentId: (agent?.id as string) ?? null, agentTitle: (agent?.title as string) ?? null, sessionId: input.sessionId, via: "explicit" };
    } else if (input.agentId) {
      const agent = agents.find((a) => a.id === input.agentId);
      const sessionId = (agent?.runtimeInfo?.sessionId as string) ?? null;
      if (sessionId) resolved = { agentId: input.agentId, agentTitle: (agent?.title as string) ?? null, sessionId, via: "agent" };
    } else {
      const mains = agents.filter((a: AgentLike) => inWsAgent(a) && !isHiddenSession(a as never));
      const running = mains.filter((a: AgentLike) => a.status === "running");
      const pool = running.length > 0 ? running : mains;
      const ts = (a: AgentLike) => Math.max(Date.parse(String(a.lastUserMessageAt ?? "")) || 0, Date.parse(String(a.updatedAt ?? "")) || 0);
      const agent = pool.sort((a, b) => ts(b) - ts(a))[0];
      const sessionId = (agent?.runtimeInfo?.sessionId as string) ?? null;
      if (sessionId && agent?.id) resolved = { agentId: agent.id as string, agentTitle: (agent?.title as string) ?? null, sessionId, via: "workspace-active" };
    }

    // 2) side list: main-chat sessions của workspace này từng có plan status
    const withFiles = new Set(await listSessionFiles());
    const titleCache = mergeLiveTitles(titleBySession);
    const sessions: PlanPanelState["sessions"] = [];
    for (const a of agents) {
      if (!inWsAgent(a) || isHiddenSession(a as never)) continue;
      const sid = a.runtimeInfo?.sessionId;
      if (typeof sid !== "string" || !sid || !withFiles.has(sid)) continue;
      sessions.push({
        sessionId: sid,
        title: titleFor(titleCache, sid, titleBySession),
        active: sid === resolved?.sessionId,
        engineLive: true,
      });
    }

    if (!resolved) {
      return { ...EMPTY, sessions, note: "no active agent with a session — pick a chip once the plan engine has run" };
    }

    const status = await readStatus(resolved.sessionId);
    if (!status) {
      return {
        ...EMPTY,
        present: true,
        sessionId: resolved.sessionId,
        resolved,
        sessions,
        note: "engine chưa ghi plan status cho session này (ext < v1.4.46 hoặc chưa dùng plan)",
      };
    }
    return { ...status, sessionId: resolved.sessionId, resolved, sessions };
  } catch {
    return { ...EMPTY, note: "read failed — is ~/.pi/agent/plan-control readable?" };
  }
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
