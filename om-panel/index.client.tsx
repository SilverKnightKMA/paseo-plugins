import type { PluginClientContext } from "@getpaseo/plugin/client";
import { OmPanel } from "./client/panel.js";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "om-panel",
    title: "OM Topics",
    icon: "Brain",
    context: "workspace",
    Component: OmPanel,
  });

  client.addCommandCenterItem({
    id: "om-panel-open",
    title: "OM Topics: topics theo session",
    icon: "Brain",
    keywords: ["memory", "om", "observational", "topics", "session"],
    context: "workspace",
    onSelect(context_) {
      context_.openPanel("om-panel");
    },
  });

  return () => {};
}
