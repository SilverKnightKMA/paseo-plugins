import os from "node:os";
import path from "node:path";
import { readFile, readdir, mkdir, writeFile, rename } from "node:fs/promises";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { GetPlanStateRpc, SetPlanControlRpc, type PlanPanelState } from "../shared/rpc.js";
import { mergeLiveTitles, titleFor } from "./titles.js";
import { isHiddenSession, unwrapAgents, type FilterAgentLike } from "./session-filter.js";

/**
 * v1.0.45 (#62): session resolution + filter share SEMANTICS with task/snip
 * (session-filter.ts / titles.ts shared, pinned by check-shared-ui.py):
 * hide archived/subagent/internal; explicit chip > agentId (pill) >
 * workspace-active main chat. The engine's read-only mode is the single writer of
 * ~/.pi/agent/plan-control/<sessionId>.status.json; this module only reads it and
 * writes the control file for user actions.
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
  planText: null,
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

// unwrapAgents lives in ./session-filter.js (shared, pinned — v1.0.50 #68)

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
    return null; // engine has not written yet — session runs an older ext or plan mode unused
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
      planText: typeof p.planText === "string" && p.planText ? p.planText : null,
      updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : null,
    };
  } catch {
    return null; // torn read — atomic rename makes this rare
  }
}

export async function readPlanState(
  input: RpcInput<typeof GetPlanStateRpc>,
  context: PluginHandlerContext,
): Promise<PlanPanelState> {
  try {
    let agents: FilterAgentLike[] = [];
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
    const inWsAgent = (a: FilterAgentLike): boolean => {
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
      const mains = agents.filter((a: FilterAgentLike) => inWsAgent(a) && !isHiddenSession(a as never));
      const running = mains.filter((a: FilterAgentLike) => a.status === "running");
      const pool = running.length > 0 ? running : mains;
      const ts = (a: FilterAgentLike) => Math.max(Date.parse(String(a.lastUserMessageAt ?? "")) || 0, Date.parse(String(a.updatedAt ?? "")) || 0);
      const agent = pool.sort((a, b) => ts(b) - ts(a))[0];
      const sessionId = (agent?.runtimeInfo?.sessionId as string) ?? null;
      if (sessionId && agent?.id) resolved = { agentId: agent.id as string, agentTitle: (agent?.title as string) ?? null, sessionId, via: "workspace-active" };
    }

    // 2) side list: main-chat sessions of this workspace that ever had a plan status
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
      // v1.0.48 (#67): self-diagnosing note — count agents / match workspace /
      // plan-status file so the panel can explain why chips are empty instead of guessing.
      return {
        ...EMPTY,
        sessions,
        note:
          sessions.length > 0
            ? "no active agent with a session — pick a chip"
            : `no session match — agents:${agents.length} inWs:${agents.filter(inWsAgent).length} planFiles:${withFiles.size} (ws:${input.workspaceId || "—"})`,
      };
    }

    const status = await readStatus(resolved.sessionId);
    if (!status) {
      return {
        ...EMPTY,
        present: true,
        sessionId: resolved.sessionId,
        resolved,
        sessions,
        note: "engine has not written a plan status for this session (ext < v1.4.46 or plan mode unused)",
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
    note: "engine applies within ~1s — the panel will auto-refresh (ack = engine online)",
  };
}
