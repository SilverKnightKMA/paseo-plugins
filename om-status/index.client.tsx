import type { PluginClientContext } from "@getpaseo/plugin/client";
import { z } from "zod";
import { OmStatusPanel } from "./client/panel.js";
import { startOmLive } from "./client/pill.js";
import { OmHistoryCard } from "./client/history.js";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "om-status",
    title: "OM Status",
    icon: "Brain",
    context: "workspace",
    Component: OmStatusPanel,
  });

  client.addCommandCenterItem({
    id: "om-status-open",
    title: "OM Status: live /om status",
    icon: "Brain",
    keywords: ["om", "memory", "status", "observer"],
    context: "workspace",
    onSelect(context_) {
      context_.openPanel("om-status");
    },
  });

  // v1.3: live chat surfaces, model-invisible by construction — these exist
  // only in the Paseo client render layer, never in pi's state.messages.
  //   · ComposerPill: always-visible live gauge pinned to the composer
  //   · timeline transformer+renderer: "om checkpoint" cards at compaction
  //     points (compaction items are replaced 1:1 by plugin cards)
  const stopPill = startOmLive(client);

  client.addTimelineTransformer({
    id: "om-history-transformer",
    query: { itemType: "compaction" },
    // v1.3.1: only card-ify COMPLETED compactions — the "loading" item that comes
    // first used to be replaced by an identical second card (2 adjacent dupes).
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
  // #39 doorbell wake signal: engine pokes the plugin server, which appends
  // kind "doorbell" timeline items (no renderer = invisible). This defensive
  // transformer removes them from display for EVERY plugin — foreign kinds
  // pass through untouched.
  client.addTimelineTransformer({
    id: "doorbell-hide",
    query: { itemType: "plugin" },
    transform: ({ item }) => {
      if (item.kind === "doorbell") return { items: [] };
      return undefined;
    },
  });

  // Doorbell wake-signal items (server/doorbell-server.ts, kind "doorbell" v1)
  // are renderer-less BY DESIGN — invisible wake pings, not content. App 0.8.0
  // shows "Plugin timeline item unavailable." for plugin items whose owning
  // plugin registers no renderer — the doorbell-hide transformer above covers
  // the live/projected path; this null renderer covers the canonical/history
  // path where transformers do not run (2026-09-22 UI audit).
  client.addTimelineRenderer({
    kind: "doorbell",
    version: 1,
    schema: z.object({ bell: z.string(), file: z.string(), ts: z.string() }),
    Component: () => null,
  });

  client.addTimelineRenderer({
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

  return () => {
    stopPill();
  };
}
