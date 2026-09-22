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
  // Doorbell wake-signal items (server/doorbell-server.ts, kind "doorbell" v1)
  // are renderer-less BY DESIGN — invisible wake pings, not content. App 0.8.0
  // shows "Plugin timeline item unavailable." for plugin items whose owning
  // plugin registers no renderer. The null renderer below is THE fix —
  // PluginTimelineItemView resolves renderers for plugin items by kind+version
  // on every projection path.
  //
  // v1.0.84 (F9 final): the doorbell-hide TRANSFORMER that lived here was
  // removed — the app's addTimelineTransformer validator only accepts
  // itemType in {user_message, assistant_message, reasoning, tool_call, todo,
  // error, compaction}; "plugin" throws "Timeline transformer doorbell-hide
  // has invalid item type" and that throw aborts the WHOLE contribute(), so
  // om-status registered NOTHING since v1.0.76 (root cause of F9).
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
