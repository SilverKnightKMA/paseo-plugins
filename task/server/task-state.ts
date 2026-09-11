import os from "node:os";
import path from "node:path";
import { readFile, readdir, mkdir, rename, writeFile } from "node:fs/promises";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { GetTaskStateRpc, SetTaskControlRpc, type TaskPanelState } from "../shared/rpc.js";
import { mergeLiveTitles, titleFor } from "./titles.js";

const EMPTY: TaskPanelState = {
  present: false,
  note: null,
  sessionId: null,
  engineLive: false,
  writtenAt: null,
  total: 0,
  done: 0,
  inProgress: 0,
  pending: 0,
  cancelled: 0,
  ready: [],
  tasks: [],
  sessions: [],
};

type AgentLike = {
  id?: string;
  workspaceId?: string | null;
  status?: string | null;
  updatedAt?: string | null;
  lastUserMessageAt?: string | null;
  title?: string | null;
  archivedAt?: string | null;
  labels?: Record<string, string> | null;
  cwd?: string | null;
  runtimeInfo?: { sessionId?: string | null } | null;
};

/** Subagent agents are labeled by the daemon/spawner (verified live
 *  2026-09-05): subagent.role, subagent.parent and/or paseo.parent-agent-id;
 *  main chats carry an empty labels object. */
function isSubagentAgent(a: AgentLike): boolean {
  const labels = a.labels;
  if (!labels) return false;
  return Boolean(labels["subagent.role"] ?? labels["subagent.parent"] ?? labels["paseo.parent-agent-id"]);
}

function isMainChat(a: AgentLike): boolean {
  return a.archivedAt == null && !isSubagentAgent(a);
}

function unwrapAgents(entries: unknown[]): AgentLike[] {
  const out: AgentLike[] = [];
  for (const e of entries) {
    const inner = (e as { agent?: unknown }).agent;
    if (inner && typeof inner === "object") out.push(inner as AgentLike);
  }
  return out;
}

function statusDir(): string {
  return path.join(os.homedir(), ".pi", "agent", "task-status");
}

async function readProjection(sessionId: string): Promise<TaskPanelState | null> {
  const file = path.join(statusDir(), `${sessionId}.json`);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null; // no file — engine never wrote for this session
  }
  try {
    const parsed = JSON.parse(raw) as {
      v?: number;
      sessionId?: string;
      writtenAt?: string;
      total?: number;
      byStatus?: Record<string, number>;
      ready?: number[];
      tasks?: Array<{
        id: number;
        subject: string;
        description?: string;
        status: string;
        evidence?: string | null;
        blockedBy?: number[];
        blocks?: number[];
        updatedAt?: number;
        failStreak?: number;
        judgeRounds?: number;
        appealReason?: string;
        verify?: { lane?: unknown; strict?: unknown; probes?: unknown[] };
        audit?: { verdict?: unknown; summary?: unknown };
      }>;
    };
    if (parsed.v !== 1) return null; // unknown projection version — refuse to render
    const tasks = (parsed.tasks ?? []).map((t) => ({
      id: t.id,
      subject: t.subject,
      description: t.description ?? "",
      status: (["pending", "in_progress", "completed", "cancelled", "parked"] as const).includes(
        t.status as "pending" | "in_progress" | "completed" | "cancelled" | "parked",
      )
        ? (t.status as "pending" | "in_progress" | "completed" | "cancelled" | "parked")
        : "pending",
      evidence: t.evidence ?? null,
      blockedBy: t.blockedBy ?? [],
      blocks: t.blocks ?? [],
      updatedAt: t.updatedAt ?? 0,
      failStreak: typeof t.failStreak === "number" ? t.failStreak : undefined,
      judgeRounds: typeof t.judgeRounds === "number" ? t.judgeRounds : undefined,
      appealReason: typeof t.appealReason === "string" ? t.appealReason : undefined,
      verify:
        t.verify && typeof t.verify === "object" && typeof t.verify.strict === "boolean"
          ? {
              lane: t.verify.lane === "judgment" ? ("judgment" as const) : ("state" as const),
              strict: t.verify.strict,
              probeCount: Array.isArray(t.verify.probes) ? t.verify.probes.length : 0,
            }
          : undefined,
      audit:
        t.audit && typeof t.audit === "object" && typeof (t.audit as { verdict?: unknown }).verdict === "string"
          ? { verdict: (t.audit as { verdict: string }).verdict, summary: String((t.audit as { summary?: unknown }).summary ?? "") }
          : undefined,
    }));
    return {
      present: true,
      note: null,
      sessionId: parsed.sessionId ?? sessionId,
      engineLive: true,
      writtenAt: parsed.writtenAt ?? null,
      total: parsed.total ?? tasks.length,
      done: parsed.byStatus?.completed ?? 0,
      inProgress: parsed.byStatus?.in_progress ?? 0,
      pending: parsed.byStatus?.pending ?? 0,
      cancelled: parsed.byStatus?.cancelled ?? 0,
      ready: parsed.ready ?? [],
      tasks,
      sessions: [],
    };
  } catch {
    return null; // torn/malformed file — treat as absent; the atomic write makes this rare
  }
}

async function listSessionFiles(): Promise<string[]> {
  try {
    const files = await readdir(statusDir());
    return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

export async function readTaskState(
  input: RpcInput<typeof GetTaskStateRpc>,
  context: PluginHandlerContext,
): Promise<TaskPanelState> {
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
      if (sid && a.title) titleBySession.set(sid, a.title);
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
      if (a.workspaceId) return a.workspaceId === input.workspaceId;
      return rootDir != null && a.cwd != null && a.cwd === rootDir;
    };

    // 1) resolution: explicit (chips) > agentId (pill) > workspace-active main chat
    let resolved: TaskPanelState["resolved"] = undefined;
    if (input.sessionId) {
      const agent = agents.find((a) => a.runtimeInfo?.sessionId === input.sessionId);
      resolved = { agentId: agent?.id ?? null, agentTitle: agent?.title ?? null, sessionId: input.sessionId, via: "explicit" };
    } else if (input.agentId) {
      const agent = agents.find((a) => a.id === input.agentId);
      const sessionId = agent?.runtimeInfo?.sessionId ?? null;
      if (sessionId) resolved = { agentId: input.agentId, agentTitle: agent?.title ?? null, sessionId, via: "agent" };
    } else {
      const mains = agents.filter((a) => inWsAgent(a) && isMainChat(a));
      const running = mains.filter((a) => a.status === "running");
      const pool = running.length > 0 ? running : mains;
      const ts = (a: AgentLike) => Math.max(Date.parse(a.lastUserMessageAt ?? "") || 0, Date.parse(a.updatedAt ?? "") || 0);
      const agent = pool.sort((a, b) => ts(b) - ts(a))[0];
      const sessionId = agent?.runtimeInfo?.sessionId ?? null;
      if (sessionId && agent?.id) resolved = { agentId: agent.id, agentTitle: agent?.title ?? null, sessionId, via: "workspace-active" };
    }

    // 2) side list: main-chat sessions of THIS workspace that have ever written
    // a projection (engineLive) — projection files carry no cwd, so agent
    // metadata is the only workspace scoping source.
    const withFiles = new Set(await listSessionFiles());
    const titleCache = mergeLiveTitles(titleBySession);
    const sessions: TaskPanelState["sessions"] = [];
    for (const a of agents) {
      if (!inWsAgent(a) || !isMainChat(a)) continue;
      const sid = a.runtimeInfo?.sessionId;
      if (!sid || !withFiles.has(sid)) continue;
      sessions.push({
        sessionId: sid,
        title: titleFor(titleCache, sid, titleBySession),
        active: sid === resolved?.sessionId,
        engineLive: true,
      });
    }

    if (!resolved) {
      return { ...EMPTY, sessions, note: "no active agent with a session — pick a chip once the task engine has run" };
    }

    const projection = await readProjection(resolved.sessionId);
    if (!projection) {
      return {
        ...EMPTY,
        present: true,
        sessionId: resolved.sessionId,
        resolved,
        sessions,
        note: "engine offline for this session — task v1.4.21+ writes the projection at session start (respawn old sessions to pick it up)",
      };
    }
    return { ...projection, resolved, sessions };
  } catch {
    return EMPTY;
  }
}

/**
 * User-only actions: write the control file, the engine applies + acks it.
 * Never touches task state directly — engine stays the single writer.
 */
export async function writeTaskControl(
  input: RpcInput<typeof SetTaskControlRpc>,
): Promise<{ ok: boolean; sentAt: string; note: string }> {
  const home = process.env.HOME ?? os.homedir();
  const dir = path.join(home, ".pi", "agent", "task-control");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${input.sessionId}.json`);
  const sentAt = new Date().toISOString();
  const payload = {
    v: 1,
    action: input.action,
    id: input.id,
    ...(input.action === "strict" ? { value: input.value ?? true } : {}),
    sentAt,
  };
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(payload), "utf8");
  await rename(tmp, file);
  return {
    ok: true,
    sentAt,
    note: `engine áp dụng trong ~1s — panel sẽ tự refresh (ack = engine online)`,
  };
}
