import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { PluginContext } from "@getpaseo/plugin";
import { z } from "zod";
import { OmStatusPanel } from "./panel.client";
import { startOmLive } from "./live.client";
import { OmHistoryCard } from "./history.client";
import { GetOmStatusRpc, OmEventSchema, OmSummarySchema, type OmStatusState } from "./rpc.js";

const OmStatusFileSchema = z.object({
  schema: z.literal(1),
  generatedAt: z.string(),
  enabled: z.boolean(),
  sessionId: z.string(),
  workspace: z.string(),
  lines: z.array(z.string()),
  summary: OmSummarySchema.nullish(),
  events: z.array(OmEventSchema),
});

const emptyState = (): OmStatusState => ({
  present: false,
  generatedAt: null,
  enabled: null,
  sessionId: null,
  workspace: null,
  lines: [],
  summary: null,
  events: [],
  ageSec: null,
  sessions: [],
});

type AgentLike = {
  id?: string;
  workspaceId?: string | null;
  status?: string | null;
  updatedAt?: string | null;
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

/** agentId → sessionId via the daemon's agent snapshot (runtimeInfo). */
async function sessionIdForAgent(paseo: { agents: { list: () => Promise<{ entries: unknown[] }> } }, agentId: string): Promise<{ sessionId: string | null; status: string | null }> {
  try {
    const res = await paseo.agents.list();
    const agent = unwrapAgents(res.entries).find((a) => a.id === agentId);
    return { sessionId: agent?.runtimeInfo?.sessionId ?? null, status: agent?.status ?? null };
  } catch {
    return { sessionId: null, status: null };
  }
}

/** No agentId (workspace panel): the ACTIVE agent of the workspace —
 *  status "running" wins, else the most recently updated. */
async function activeAgentOfWorkspace(paseo: { agents: { list: () => Promise<{ entries: unknown[] }> } }, workspaceId: string): Promise<AgentLike | null> {
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

/** Read the workspace OM status snapshot written by the observational-memory
 *  extension (v2 display channel). Never throws — a missing/stale file is a
 *  valid state ("OM off / not installed / no event yet"), returned as such.
 *
 *  v1.2.4+: the file is session-scoped (.memory/<sessionId>/om-status.json);
 *  several chats in one workspace each keep their own. We resolve the NEWEST
 *  file (the most recently active OM session) and fall back to the legacy
 *  workspace-level path during the transition. */
async function readOmStatus(
  input: { workspaceId: string; agentId?: string | null },
  context: Parameters<Parameters<PluginContext["handle"]>[1]>[1],
): Promise<OmStatusState> {
  const empty = emptyState();
  try {
    const handle = context.paseo.workspaces.ref(input.workspaceId);
    let ws = handle.current();
    if (!ws?.workspaceDirectory) ws = await handle.refresh();
    const directory = ws?.workspaceDirectory ?? null;
    if (!directory) return { ...empty, note: "workspace directory chưa xác định được" };

    // 1) resolve the target session — deterministic, agent-driven
    let resolved: OmStatusState["resolved"] = undefined;
    if (input.agentId) {
      const { sessionId, status } = await sessionIdForAgent(context.paseo, input.agentId);
      if (sessionId) resolved = { agentId: input.agentId, sessionId, status, via: "agent" };
    } else {
      const agent = await activeAgentOfWorkspace(context.paseo, input.workspaceId);
      const sessionId = agent?.runtimeInfo?.sessionId ?? null;
      if (sessionId && agent?.id) resolved = { agentId: agent.id, sessionId, status: agent.status ?? null, via: "workspace-active" };
    }
    if (!resolved) {
      return {
        ...empty,
        workspace: directory,
        note: input.agentId ? "agent chưa có runtimeInfo (đang khởi động / chưa chạy turn nào)" : "không tìm thấy agent active nào có runtimeInfo",
      };
    }

    // 2) enumerate per-session files for the side list (display only)
    const memoryDir = path.join(directory, ".memory");
    const sessionDirs = (await readdir(memoryDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    const sessions: { sessionId: string; ageSec: number }[] = [];
    for (const sessionId of sessionDirs) {
      try {
        const mtime = (await stat(path.join(memoryDir, sessionId, "om-status.json"))).mtimeMs;
        sessions.push({ sessionId, ageSec: Math.round((Date.now() - mtime) / 1000) });
      } catch {
        // no status file for this session — not listed
      }
    }

    // 3) read the EXACT resolved session's file
    const file = path.join(memoryDir, resolved.sessionId, "om-status.json");
    const parsed = OmStatusFileSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!parsed.success) {
      return {
        ...empty,
        workspace: directory,
        resolved,
        sessions,
        note: "session này chưa ghi om-status.json (OM off hoặc chưa có event)",
      };
    }
    const data = parsed.data;
    return {
      present: true,
      generatedAt: data.generatedAt,
      enabled: data.enabled,
      sessionId: data.sessionId || resolved.sessionId,
      workspace: data.workspace,
      lines: data.lines,
      summary: data.summary ?? null,
      events: [...data.events].reverse(), // newest first for the panel
      ageSec: Math.round((Date.now() - Date.parse(data.generatedAt)) / 1000),
      sessions,
      resolved,
    };
  } catch {
    return empty;
  }
}

export default function contribute(plugin: PluginContext) {
  plugin.handle(GetOmStatusRpc, async (input, context) => readOmStatus(input, context));

  plugin.addWorkspacePanel({
    id: "om-status",
    title: "OM Status",
    icon: "Brain",
    context: "workspace",
    Component: OmStatusPanel,
  });

  plugin.addCommandCenterItem({
    id: "om-status-open",
    title: "OM Status: live /om status",
    icon: "Brain",
    keywords: ["om", "memory", "status", "observer"],
    context: "workspace",
    onSelect(context_: { openPanel: (id: string) => void }) {
      context_.openPanel("om-status");
    },
  });

  // v1.3: live chat surfaces, model-invisible by construction — these exist
  // only in the Paseo client render layer, never in pi's state.messages.
  //   · ComposerPill: always-visible live gauge pinned to the composer
  //   · timeline transformer+renderer: "om checkpoint" cards at compaction
  //     points (compaction items are replaced 1:1 by plugin cards)
  plugin.addClientSide((client) => startOmLive(client));
  plugin.addTimelineTransformer({
    id: "om-history-transformer",
    query: { itemType: "compaction" },
    transform: ({ item }) => ({
      items: [
        {
          type: "plugin" as const,
          kind: "om-history",
          version: 1,
          data: {
            compaction: {
              status: item.status,
              trigger: item.trigger ?? null,
              preTokens: item.preTokens ?? null,
            },
          },
        },
      ],
    }),
  });
  plugin.addTimelineRenderer({
    kind: "om-history",
    version: 1,
    schema: z.object({
      compaction: z.object({
        status: z.string(),
        trigger: z.string().nullable(),
        preTokens: z.number().nullable(),
      }),
    }),
    Component: OmHistoryCard,
  });

  return () => {};
}
