import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SnipPanel } from "./client/panel.js";
import { startSnipLive } from "./client/pill.js";

export default function contribute(client: PluginClientContext) {
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
