import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PluginContext } from "@getpaseo/plugin";
import { z } from "zod";
import { OmStatusPanel } from "./panel.client";
import { GetOmStatusRpc, OmEventSchema, type OmStatusState } from "./rpc.js";

const OmStatusFileSchema = z.object({
  schema: z.literal(1),
  generatedAt: z.string(),
  enabled: z.boolean(),
  sessionId: z.string(),
  workspace: z.string(),
  lines: z.array(z.string()),
  events: z.array(OmEventSchema),
});

/** Read the workspace OM status snapshot written by the observational-memory
 *  extension (v2 display channel). Never throws — a missing/stale file is a
 *  valid state ("OM off / not installed / no event yet"), returned as such. */
async function readOmStatus(
  workspaceId: string,
  context: Parameters<Parameters<PluginContext["handle"]>[1]>[1],
): Promise<OmStatusState> {
  const empty = {
    present: false,
    generatedAt: null,
    enabled: null,
    sessionId: null,
    workspace: null,
    lines: [],
    events: [],
    ageSec: null,
  };
  try {
    const handle = context.paseo.workspaces.ref(workspaceId);
    let ws = handle.current();
    if (!ws?.workspaceDirectory) ws = await handle.refresh();
    const directory = ws?.workspaceDirectory ?? null;
    if (!directory) return empty;
    const file = path.join(directory, ".memory", "om-status.json");
    const parsed = OmStatusFileSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!parsed.success) return { ...empty, workspace: directory };
    const data = parsed.data;
    return {
      present: true,
      generatedAt: data.generatedAt,
      enabled: data.enabled,
      sessionId: data.sessionId,
      workspace: data.workspace,
      lines: data.lines,
      events: [...data.events].reverse(), // newest first for the panel
      ageSec: Math.round((Date.now() - Date.parse(data.generatedAt)) / 1000),
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

  return () => {};
}
