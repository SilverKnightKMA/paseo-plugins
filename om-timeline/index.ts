import type { PluginContext } from "@getpaseo/plugin";
import { z } from "zod";
import { OmCard } from "./card.client";
import { CARD_KIND, MARKER_VERSION, detectMarker } from "./markers.js";

const CardDataSchema = z.object({
  variant: z.enum(["om-event", "zw-warning", "auto-report", "channel-nack"]),
  text: z.string(),
});

export default function contribute(plugin: PluginContext) {
  plugin.addTimelineTransformer({
    id: "om-timeline-transform",
    query: { itemType: "assistant_message" },
    transform({ item }) {
      const card = detectMarker(item.text ?? "");
      if (!card) return undefined; // pass through untouched
      return {
        items: [
          {
            type: "plugin" as const,
            kind: CARD_KIND,
            version: MARKER_VERSION,
            data: card,
          },
        ],
      };
    },
  });

  plugin.addTimelineRenderer({
    kind: CARD_KIND,
    version: MARKER_VERSION,
    schema: CardDataSchema,
    Component: OmCard,
  });

  return () => {
    // nothing to dispose: transformer/renderer unregister with the plugin
  };
}
