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

/** Read the workspace OM status snapshot written by the observational-memory
 *  extension (v2 display channel). Never throws — a missing/stale file is a
 *  valid state ("OM off / not installed / no event yet"), returned as such.
 *
 *  v1.2.4+: the file is session-scoped (.memory/<sessionId>/om-status.json);
 *  several chats in one workspace each keep their own. We resolve the NEWEST
 *  file (the most recently active OM session) and fall back to the legacy
 *  workspace-level path during the transition. */
async function readOmStatus(
  workspaceId: string,
  context: Parameters<Parameters<PluginContext["handle"]>[1]>[1],
): Promise<OmStatusState> {
  const empty = emptyState();
  try {
    const handle = context.paseo.workspaces.ref(workspaceId);
    let ws = handle.current();
    if (!ws?.workspaceDirectory) ws = await handle.refresh();
    const directory = ws?.workspaceDirectory ?? null;
    if (!directory) return empty;

    const memoryDir = path.join(directory, ".memory");
    const sessionDirs = (await readdir(memoryDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

    // newest per-session file wins; legacy workspace-level file is the fallback
    let newest: { file: string; mtime: number; sessionId: string } | null = null;
    const sessions: { sessionId: string; ageSec: number }[] = [];
    for (const sessionId of sessionDirs) {
      const file = path.join(memoryDir, sessionId, "om-status.json");
      let mtime: number;
      try {
        mtime = (await stat(file)).mtimeMs;
      } catch {
        continue;
      }
      sessions.push({ sessionId, ageSec: Math.round((Date.now() - mtime) / 1000) });
      if (!newest || mtime > newest.mtime) newest = { file, mtime, sessionId };
    }
    if (!newest) newest = { file: path.join(memoryDir, "om-status.json"), mtime: 0, sessionId: "" };

    const parsed = OmStatusFileSchema.safeParse(JSON.parse(await readFile(newest.file, "utf8")));
    if (!parsed.success) return { ...empty, workspace: directory, sessions };
    const data = parsed.data;
    return {
      present: true,
      generatedAt: data.generatedAt,
      enabled: data.enabled,
      sessionId: data.sessionId || newest.sessionId,
      workspace: data.workspace,
      lines: data.lines,
      summary: data.summary ?? null,
      events: [...data.events].reverse(), // newest first for the panel
      ageSec: Math.round((Date.now() - Date.parse(data.generatedAt)) / 1000),
      sessions,
    };
  } catch {
    return empty;
  }
}

export default function contribute(plugin: PluginContext) {
  plugin.handle(GetOmStatusRpc, async (input, context) => readOmStatus(input.workspaceId, context));

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
