import fs from "node:fs";
import path from "node:path";
import type { PluginContext } from "@getpaseo/plugin";
import { GetOmStateRpc, type SessionBrief, type SessionDetail } from "./rpc.js";
import { mergeLiveTitles, titleFor } from "./titles.js";
import { OmPanel } from "./panel.client.js";

type AgentLike = {
  id?: string;
  workspaceId?: string | null;
  status?: string | null;
  updatedAt?: string | null;
  title?: string | null;
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

async function activeAgentOfWorkspace(
  paseo: { agents: { list: () => Promise<{ entries: unknown[] }> } },
  workspaceId: string,
): Promise<AgentLike | null> {
  try {
    const res = await paseo.agents.list();
    const inWs = unwrapAgents(res.entries).filter((a) => a.workspaceId === workspaceId);
    const running = inWs.find((a) => a.status === "running");
    if (running) return running;
    return inWs.sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""))[0] ?? null;
  } catch {
    return null;
  }
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

export default function contribute(plugin: PluginContext) {
  plugin.handle(GetOmStateRpc, async (input, context) => {
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

      // titles: live from agents.list() + cache for dead sessions (shares the
      // cache file with om-status — source of truth is the Paseo agent title)
      const liveTitles = new Map<string, string>();
      try {
        const res = await context.paseo.agents.list();
        for (const a of unwrapAgents(res.entries)) {
          const sid = a.runtimeInfo?.sessionId;
          if (sid && a.title) liveTitles.set(sid, a.title);
        }
      } catch {
        // cache-only fallback
      }
      const titleCache = mergeLiveTitles(liveTitles);
      for (const b of briefs) b.title = titleFor(titleCache, b.sessionId, liveTitles);

      // resolution chain: explicit → agent → workspace-active → newest
      let sessionId: string | null = input.sessionId ?? null;
      let via: "explicit" | "agent" | "workspace-active" | "newest" = "explicit";
      let agent: AgentLike | null = null;
      if (!sessionId) {
        if (input.agentId) {
          try {
            const res = await context.paseo.agents.list();
            agent = unwrapAgents(res.entries).find((a) => a.id === input.agentId) ?? null;
          } catch {
            agent = null;
          }
          if (agent?.runtimeInfo?.sessionId) via = "agent";
        } else {
          agent = await activeAgentOfWorkspace(context.paseo, input.workspaceId);
          if (agent?.runtimeInfo?.sessionId) via = "workspace-active";
        }
        sessionId = agent?.runtimeInfo?.sessionId ?? null;
        if (!sessionId) {
          sessionId = briefs[0]?.sessionId ?? null;
          via = "newest";
        }
      } else {
        // explicit (user-picked): look the session's agent back up to keep the "agent: X"
        // line — for dead sessions the title still comes from the chip cache.
        try {
          const res = await context.paseo.agents.list();
          agent = unwrapAgents(res.entries).find((a) => a.runtimeInfo?.sessionId === sessionId) ?? null;
        } catch {
          agent = null;
        }
      }

      const resolved = sessionId ? { sessionId, agentId: agent?.id ?? null, agentTitle: agent?.title ?? null, via } : undefined;
      const sessions = briefs.map((b) => ({ ...b, active: b.sessionId === sessionId }));
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
  });

  plugin.addWorkspacePanel({
    id: "om-panel",
    title: "OM Topics",
    icon: "Brain",
    context: "workspace",
    Component: OmPanel,
  });

  plugin.addCommandCenterItem({
    id: "om-panel-open",
    title: "OM Topics: topics theo session",
    icon: "Brain",
    keywords: ["memory", "om", "observational", "topics", "session"],
    context: "workspace",
    onSelect(context_) {
      context_.openPanel("om-panel");
    },
  });

  return () => {};
}
