import fs from "node:fs";
import path from "node:path";
import type { PluginContext } from "@getpaseo/plugin";
import { GetOmStateRpc, type SessionBrief, type SessionDetail } from "./rpc.js";
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
      active: false, // đánh dấu ở caller sau khi resolve
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
        return { present: false, workspace: null, sessions: [], note: "workspace directory chưa xác định được", generatedAt: new Date().toISOString() };
      }
      const memoryDir = path.join(directory, ".memory");
      const { briefs, byId } = listSessions(memoryDir, input.indexLines);

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
        note: session ? null : sessionId ? "session này chưa có topic files (OM chưa ghi gì)" : "chưa có session nào trong .memory",
        generatedAt: new Date().toISOString(),
      };
    } catch (err) {
      return { present: false, workspace: null, sessions: [], note: `scan lỗi: ${String(err)}`, generatedAt: new Date().toISOString() };
    }
  });

  plugin.addWorkspacePanel({
    id: "om-panel",
    title: "Observational Memory",
    icon: "Brain",
    context: "workspace",
    Component: OmPanel,
  });

  plugin.addCommandCenterItem({
    id: "om-panel-open",
    title: "Observational Memory: topics theo session",
    icon: "Brain",
    keywords: ["memory", "om", "observational", "topics", "session"],
    context: "workspace",
    onSelect(context_) {
      context_.openPanel("om-panel");
    },
  });

  return () => {};
}
