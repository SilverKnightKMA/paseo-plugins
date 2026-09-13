import fs from "node:fs";
import path from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { GetOmStateRpc, type SessionBrief, type SessionDetail } from "../shared/rpc.js";
import { mergeLiveTitles, titleFor } from "./titles.js";
import { visibleOm, type FilterAgentLike } from "./session-filter.js";

type AgentLike = {
  id?: string;
  workspaceId?: string | null;
  status?: string | null;
  updatedAt?: string | null;
  title?: string | null;
  archivedAt?: string | null;
  labels?: Record<string, string> | null;
  runtimeInfo?: { sessionId?: string | null } | null;
};

/** Wire entries are wrappers: { agent: <snapshot> }. Unwrap defensively. */
function unwrapAgents(entries: unknown[]): AgentLike[] {
  const out: AgentLike[] = [];
  for (const e of entries) {
    const inner = (e as { agent?: unknown }).agent;
    if (inner && typeof inner === "object") out.push(inner as AgentLike);
  }
  return out;
}

async function activeAgentOfWorkspace(agents: AgentLike[], workspaceId: string): Promise<AgentLike | null> {
  const inWs = agents.filter((a) => a.workspaceId === workspaceId);
  const running = inWs.find((a) => a.status === "running");
  if (running) return running;
  return inWs.sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""))[0] ?? null;
}

/** All .memory/<sessionId>/ dirs of the workspace, newest activity first. */
function listSessions(memoryDir: string, indexLines: number): { briefs: SessionBrief[]; byId: Map<string, SessionDetail> } {
  const briefs: SessionBrief[] = [];
  const byId = new Map<string, SessionDetail>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(memoryDir, { withFileTypes: true });
  } catch {
    return { briefs, byId };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionDir = path.join(memoryDir, entry.name);
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(sessionDir, { withFileTypes: true });
    } catch {
      continue;
    }
    let totalBytes = 0;
    let newestMs = 0;
    const indexHead: string[] = [];
    const topics: { file: string; kb: number; modified: string }[] = [];
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".md")) continue;
      const full = path.join(sessionDir, f.name);
      try {
        const st = fs.statSync(full);
        totalBytes += st.size;
        newestMs = Math.max(newestMs, st.mtimeMs);
        if (f.name === "INDEX.md") {
          for (const line of fs.readFileSync(full, "utf8").split("\n").slice(0, indexLines)) {
            if (line.trim()) indexHead.push(line.trim().slice(0, 100));
          }
        } else {
          topics.push({ file: f.name, kb: Math.round(st.size / 102.4) / 10, modified: new Date(st.mtimeMs).toISOString() });
        }
      } catch {
        // Skip unreadable file.
      }
    }
    topics.sort((a, b) => b.modified.localeCompare(a.modified));
    const brief: SessionBrief = {
      sessionId: entry.name,
      topicFiles: topics.length,
      totalKb: Math.round(totalBytes / 1024),
      lastModified: newestMs > 0 ? new Date(newestMs).toISOString() : null,
      active: false, // set by the caller after resolution
      title: null, // filled from live/cache at the caller
    };
    briefs.push(brief);
    byId.set(entry.name, { ...brief, indexHead, topics });
  }
  briefs.sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? ""));
  return { briefs, byId };
}

export async function omStateHandler(input: RpcInput<typeof GetOmStateRpc>, context: PluginHandlerContext) {
    try {
      const handle = context.paseo.workspaces.ref(input.workspaceId);
      let ws = handle.current();
      if (!ws?.workspaceDirectory) ws = await handle.refresh();
      const directory = ws?.workspaceDirectory ?? null;
      if (!directory) {
        return { present: false, workspace: null, sessions: [], note: "workspace directory not resolved", generatedAt: new Date().toISOString() };
      }
      const memoryDir = path.join(directory, ".memory");
      const { briefs, byId } = listSessions(memoryDir, input.indexLines);

      // agents: ONE list call feeds titles, resolution, and the v1.0.29 chip filter
      let agents: AgentLike[] = [];
      try {
        agents = unwrapAgents((await context.paseo.agents.list()).entries);
      } catch {
        // metadata unavailable → chips stay unfiltered (graceful), titles cache-only
      }

      // v1.0.29: chips list only sessions the daemon still knows — main-chat
      // agents of THIS workspace. Dead chats (agent killed/archived) drop off,
      // mirroring the task panel's scoping doctrine. Display-scope only: an
      // explicit pick still renders even when its chip is filtered out.
      // v1.0.31: OM pair visibility — shared visibleOm (om-status uses the SAME
      // function on the same inputs; check-shared-ui.py pins the copies). Hidden =
      // archived / internal / subagent; disk-only sessions (no agent record) drop too.
      const visibleIds = new Set(
        visibleOm(agents, (a: FilterAgentLike) => a.workspaceId === input.workspaceId, new Set(briefs.map((b) => b.sessionId))).map(
          (v) => v.sessionId,
        ),
      );
      const visible = agents.length > 0 ? briefs.filter((b) => visibleIds.has(b.sessionId)) : briefs;

      // titles: live from agents + cache for sessions whose agent is gone (shares the
      // cache file with om-status — source of truth is the Paseo agent title)
      const liveTitles = new Map<string, string>();
      for (const a of agents) {
        const sid = a.runtimeInfo?.sessionId;
        if (sid && a.title) liveTitles.set(sid, a.title);
      }
      const titleCache = mergeLiveTitles(liveTitles);
      for (const b of briefs) b.title = titleFor(titleCache, b.sessionId, liveTitles);

      // resolution chain: explicit → agent → workspace-active → newest
      let sessionId: string | null = input.sessionId ?? null;
      let via: "explicit" | "agent" | "workspace-active" | "newest" = "explicit";
      let agent: AgentLike | null = null;
      if (!sessionId) {
        if (input.agentId) {
          agent = agents.find((a) => a.id === input.agentId) ?? null;
          if (agent?.runtimeInfo?.sessionId) via = "agent";
        } else {
          agent = await activeAgentOfWorkspace(agents, input.workspaceId);
          if (agent?.runtimeInfo?.sessionId) via = "workspace-active";
        }
        sessionId = agent?.runtimeInfo?.sessionId ?? null;
        if (!sessionId) {
          sessionId = visible[0]?.sessionId ?? null;
          via = "newest";
        }
      } else {
        // explicit (user-picked): look the session's agent back up to keep the "agent: X"
        // line — for dead sessions the title still comes from the chip cache.
        agent = agents.find((a) => a.runtimeInfo?.sessionId === sessionId) ?? null;
      }

      const resolved = sessionId ? { sessionId, agentId: agent?.id ?? null, agentTitle: agent?.title ?? null, via } : undefined;
      const sessions = visible.map((b) => ({ ...b, active: b.sessionId === sessionId }));
      const session = sessionId ? byId.get(sessionId) : undefined;

      return {
        present: Boolean(session),
        workspace: path.basename(directory),
        resolved,
        session,
        sessions,
        note: session ? null : sessionId ? "this session has no topic files yet (OM has written nothing)" : "no sessions in .memory",
        generatedAt: new Date().toISOString(),
      };
    } catch (err) {
      return { present: false, workspace: null, sessions: [], note: `scan failed: ${String(err)}`, generatedAt: new Date().toISOString() };
    }
}
