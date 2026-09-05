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
  /** gần "focus" nhất phía server: agent nhận user message gần nhất */
  lastUserMessageAt?: string | null;
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

async function readOmStatus(
  input: { workspaceId: string; agentId?: string | null; sessionId?: string | null },
  context: Parameters<Parameters<PluginContext["handle"]>[1]>[1],
): Promise<OmStatusState> {
  const empty = emptyState();
  try {
    const handle = context.paseo.workspaces.ref(input.workspaceId);
    let ws = handle.current();
    if (!ws?.workspaceDirectory) ws = await handle.refresh();
    const directory = ws?.workspaceDirectory ?? null;
    if (!directory) return { ...empty, note: "workspace directory chưa xác định được" };

    // danh sách agent 1 lần — dùng cho resolution + map sessionId → title
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

    // 1) resolution: explicit (chips picker) > agentId > workspace-active
    let resolved: OmStatusState["resolved"] = undefined;
    if (input.sessionId) {
      const agent = agents.find((a) => a.runtimeInfo?.sessionId === input.sessionId);
      resolved = {
        agentId: agent?.id ?? null,
        agentTitle: agent?.title ?? null,
        sessionId: input.sessionId,
        status: agent?.status ?? null,
        via: "explicit",
      };
    } else if (input.agentId) {
      const agent = agents.find((a) => a.id === input.agentId);
      const sessionId = agent?.runtimeInfo?.sessionId ?? null;
      if (sessionId)
        resolved = { agentId: input.agentId, agentTitle: agent?.title ?? null, sessionId, status: agent?.status ?? null, via: "agent" };
    } else {
      const inWs = agents.filter((a) => a.workspaceId === input.workspaceId);
      const running = inWs.filter((a) => a.status === "running");
      const pool = running.length > 0 ? running : inWs;
      const ts = (a: AgentLike) => Math.max(Date.parse(a.lastUserMessageAt ?? "") || 0, Date.parse(a.updatedAt ?? "") || 0);
      const agent = pool.sort((a, b) => ts(b) - ts(a))[0];
      const sessionId = agent?.runtimeInfo?.sessionId ?? null;
      if (sessionId && agent?.id)
        resolved = { agentId: agent.id, agentTitle: agent?.title ?? null, sessionId, status: agent.status ?? null, via: "workspace-active" };
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
    const sessions: { sessionId: string; ageSec: number; title: string | null }[] = [];
    for (const sessionId of sessionDirs) {
      try {
        const mtime = (await stat(path.join(memoryDir, sessionId, "om-status.json"))).mtimeMs;
        sessions.push({ sessionId, ageSec: Math.round((Date.now() - mtime) / 1000), title: titleBySession.get(sessionId) ?? null });
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
    // v1.3.1: chỉ card hóa compaction HOÀN TẤT — item "loading" đi trước từng bị
    // thay thành card thứ hai y hệt (2 card liền kề, giống hệt số liệu).
    transform: ({ item }) => {
      if (item.status !== "completed") return undefined;
      return {
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
      };
    },
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
