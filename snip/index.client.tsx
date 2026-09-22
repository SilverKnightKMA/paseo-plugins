import type { PluginClientContext } from "@getpaseo/plugin/client";
import { z } from "zod";
import { SnipPanel } from "./client/panel.js";
import { startSnipLive } from "./client/pill.js";

export default function contribute(client: PluginClientContext) {
  // Doorbell wake-signal items (server/doorbell-server.ts, kind "doorbell" v1)
  // are renderer-less BY DESIGN — invisible wake pings, not content. App 0.8.0
  // shows "Plugin timeline item unavailable." for plugin items whose owning
  // plugin registers no renderer — register a null renderer so bells stay
  // invisible as designed (2026-09-22 UI audit).
  client.addTimelineRenderer({
    kind: "doorbell",
    version: 1,
    schema: z.object({ bell: z.string(), file: z.string(), ts: z.string() }),
    Component: () => null,
  });

  client.addWorkspacePanel({
    id: "snip",
    title: "Snip",
    icon: "MessageSquare",
    context: "workspace",
    Component: SnipPanel,
  });

  client.addCommandCenterItem({
    id: "snip-open",
    title: "Snip: prompt snippets on/off",
    icon: "MessageSquare",
    keywords: ["snip", "snippet", "prompt", "rules"],
    context: "workspace",
    onSelect(context_) {
      context_.openPanel("snip");
    },
  });

  // Composer pill: live active-count gauge per agent, model-invisible by
  // construction (client render layer only, never in pi's state.messages).
  const stopPill = startSnipLive(client);

  return () => {
    stopPill();
  };
}
