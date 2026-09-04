import fs from "node:fs";
import path from "node:path";
import type { PluginContext } from "@getpaseo/plugin";
import { GetOmStateRpc, WorkspaceMemorySchema } from "./rpc.js";
import { OmPanel } from "./panel.client.js";

const WORKSPACES_ROOT = "/home/coder/workspaces";

interface SessionInfo {
  sessionId: string;
  topicFiles: number;
  totalKb: number;
  lastModified: string | null;
  indexHead: string[];
}

function scanMemoryDir(memoryDir: string, indexLines: number): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(memoryDir, { withFileTypes: true });
  } catch {
    return sessions;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const sessionDir = path.join(memoryDir, entry.name);
    let topicFiles = 0;
    let totalBytes = 0;
    let newestMs = 0;
    const indexHead: string[] = [];
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(sessionDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".md")) {
        continue;
      }
      const full = path.join(sessionDir, f.name);
      try {
        const st = fs.statSync(full);
        totalBytes += st.size;
        newestMs = Math.max(newestMs, st.mtimeMs);
        if (f.name === "INDEX.md") {
          const lines = fs.readFileSync(full, "utf8").split("\n");
          for (const line of lines.slice(0, indexLines)) {
            if (line.trim()) {
              indexHead.push(line.trim().slice(0, 100));
            }
          }
        } else {
          topicFiles += 1;
        }
      } catch {
        // Skip unreadable file.
      }
    }
    sessions.push({
      sessionId: entry.name,
      topicFiles,
      totalKb: Math.round(totalBytes / 1024),
      lastModified: newestMs > 0 ? new Date(newestMs).toISOString() : null,
      indexHead,
    });
  }
  sessions.sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? ""));
  return sessions;
}

export default function contribute(plugin: PluginContext) {
  plugin.handle(GetOmStateRpc, async (input) => {
    const workspaces: unknown[] = [];
    let wsEntries: fs.Dirent[];
    try {
      wsEntries = fs.readdirSync(WORKSPACES_ROOT, { withFileTypes: true });
    } catch {
      wsEntries = [];
    }
    for (const ws of wsEntries) {
      if (!ws.isDirectory() || ws.name.startsWith(".")) {
        continue;
      }
      const memoryDir = path.join(WORKSPACES_ROOT, ws.name, ".memory");
      const sessions = scanMemoryDir(memoryDir, input.indexLines);
      if (sessions.length === 0) {
        continue;
      }
      workspaces.push({ workspace: ws.name, sessions });
    }
    return {
      workspaces: WorkspaceMemorySchema.array().parse(workspaces),
      generatedAt: new Date().toISOString(),
    };
  });

  plugin.addWorkspacePanel({
    id: "om-panel",
    title: "Observational Memory",
    icon: "Brain",
    context: "workspace",
    Component: OmPanel,
  });

  plugin.addCommandCenterItem({
    id: "om-panel.open",
    title: "Observational Memory: topics across workspaces",
    icon: "Brain",
    keywords: ["memory", "om", "observational", "topics"],
    context: "workspace",
    onSelect(context_) {
      context_.openPanel("om-panel");
    },
  });

  return () => {};
}
