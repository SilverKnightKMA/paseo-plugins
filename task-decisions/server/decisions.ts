import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { GetDecisionsRpc, PokeControlRpc, type SessionDecisions } from "../shared/rpc.js";
import { pokeEngineBridges } from "./doorbell-poke.js";

/** Wire entries are wrappers: { agent: <snapshot> }. Unwrap defensively. */
function unwrapAgents(entries: unknown[]): { id?: string; workspaceId?: string | null; title?: string | null; runtimeInfo?: { sessionId?: string | null } | null }[] {
  const out: typeof unwrapAgents extends (...a: never[]) => infer R ? R : never[] = [];
  for (const e of entries) {
    const inner = (e as { agent?: unknown }).agent;
    if (inner && typeof inner === "object") out.push(inner as (typeof out)[number]);
  }
  return out;
}

function agentHome(): string {
  return process.env.HOME ?? homedir();
}

interface DecisionEntryRaw {
  id?: unknown;
  taskId?: unknown;
  kind?: unknown;
  reason?: unknown;
  createdAt?: unknown;
  decidedAt?: unknown;
  decision?: unknown;
}

export function sanitizeEntries(raw: unknown): { id: string; taskId: number; kind: "amend" | "cancel-proposal" | "appeal" | "note"; reason: string; createdAt: string; decidedAt: string | null; decision: "approved" | "rejected" | null }[] {
  if (!Array.isArray(raw)) return [];
  const out: ReturnType<typeof sanitizeEntries> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const e = item as DecisionEntryRaw;
    if (typeof e.id !== "string" || !/^d-\d+$/.test(e.id)) continue;
    if (typeof e.taskId !== "number" || typeof e.kind !== "string") continue;
    if (!["amend", "cancel-proposal", "appeal", "note"].includes(e.kind)) continue;
    out.push({
      id: e.id,
      taskId: e.taskId,
      kind: e.kind as "amend" | "cancel-proposal" | "appeal" | "note",
      reason: typeof e.reason === "string" ? e.reason : "",
      createdAt: typeof e.createdAt === "string" ? e.createdAt : "",
      decidedAt: typeof e.decidedAt === "string" ? e.decidedAt : null,
      decision: e.decision === "approved" || e.decision === "rejected" ? e.decision : null,
    });
  }
  return out;
}

interface TaskProjection {
  tasks?: Array<{ id?: unknown; subject?: unknown; status?: unknown }>;
}

function sanitizeTasks(raw: unknown): { id: number; subject: string; status: string }[] {
  const parsed = raw as TaskProjection | null;
  if (!parsed || !Array.isArray(parsed.tasks)) return [];
  const out: { id: number; subject: string; status: string }[] = [];
  for (const t of parsed.tasks) {
    if (typeof t?.id !== "number" || typeof t?.subject !== "string") continue;
    out.push({ id: t.id, subject: t.subject, status: typeof t.status === "string" ? t.status : "?" });
  }
  return out;
}

/** Read every workspace session's decisions artifact + task subjects. */
export async function readDecisions(
  input: RpcInput<typeof GetDecisionsRpc>,
  context: PluginHandlerContext,
): Promise<{ sessions: SessionDecisions[]; note: string | null }> {
  try {
    let agents: ReturnType<typeof unwrapAgents> = [];
    try {
      agents = unwrapAgents((await context.paseo.agents.list()).entries);
    } catch {
      agents = [];
    }
    const inWs = agents.filter((a) => a.workspaceId === input.workspaceId && a.runtimeInfo?.sessionId);
    const sessions: SessionDecisions[] = [];
    for (const a of inWs) {
      const sessionId = a.runtimeInfo!.sessionId as string;
      let entries: ReturnType<typeof sanitizeEntries> = [];
      try {
        entries = sanitizeEntries(JSON.parse(await readFile(path.join(agentHome(), ".pi", "agent", "task-status", `${sessionId}.decisions.json`), "utf8")));
      } catch {
        continue; // no artifact for this session — skip
      }
      const visible = input.includeDecided ? entries : entries.filter((e) => e.decidedAt === null);
      if (visible.length === 0) continue;
      let tasks: { id: number; subject: string; status: string }[] = [];
      try {
        tasks = sanitizeTasks(JSON.parse(await readFile(path.join(agentHome(), ".pi", "agent", "task-status", `${sessionId}.json`), "utf8")));
      } catch {
        tasks = [];
      }
      const referenced = new Set(visible.map((e) => e.taskId));
      sessions.push({
        sessionId,
        agentTitle: a.title ?? null,
        tasks: tasks.filter((t) => referenced.has(t.id)),
        entries: visible,
      });
    }
    return { sessions, note: sessions.length === 0 ? "no pending decisions — cards appear when the engine records amend/appeal/cancel-proposal/note entries" : null };
  } catch {
    return { sessions: [], note: null };
  }
}

/** Write a control file + poke the engine bell. Disk is truth; the engine
 *  applies, acks, and notifies the model. The plugin never decides inline. */
export async function pokeControl(
  input: RpcInput<typeof PokeControlRpc>,
): Promise<{ ok: boolean; note: string }> {
  try {
    if (input.action === "plan-on") {
      // read-only-mode plan-control: {v:1, action:"on", sentAt} (user door)
      const dir = path.join(agentHome(), ".pi", "agent", "plan-control");
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `${input.sessionId}.json`);
      const payload = { v: 1, action: "on", sentAt: new Date().toISOString() };
      await writeFile(file, JSON.stringify(payload), "utf8");
      await pokeEngineBridges("plan-control", file, input.sessionId);
      return { ok: true, note: "plan-mode ON requested — the engine enters plan mode for that session" };
    }
    // task-control verbs (v1.4.135 shapes): proposal-decide {dId} | cancel
    const dir = path.join(agentHome(), ".pi", "agent", "task-control");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${input.sessionId}.json`);
    const payload: Record<string, unknown> = { v: 1, action: input.action, id: input.taskId ?? 0, sentAt: new Date().toISOString() };
    if (input.dId) payload.dId = input.dId;
    if (input.decision) payload.decision = input.decision;
    await writeFile(file, JSON.stringify(payload), "utf8");
    await pokeEngineBridges("task-control", file, input.sessionId);
    return { ok: true, note: `${input.action} sent — the engine applies it and tells the model` };
  } catch (err) {
    return { ok: false, note: `poke failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
