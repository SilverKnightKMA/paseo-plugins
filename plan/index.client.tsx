import type { PluginClientContext } from "@getpaseo/plugin/client";
import { PlanPanel } from "./client/panel.js";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "plan",
    title: "Plan",
    icon: "Map",
    context: "workspace",
    Component: PlanPanel,
  });

  client.addCommandCenterItem({
    id: "plan-open",
    title: "Plan: plan-mode status + duyệt plan",
    icon: "Map",
    keywords: ["plan", "approve", "steps", "roadmap"],
    context: "workspace",
    onSelect(context_) {
      context_.openPanel("plan");
    },
  });
}
