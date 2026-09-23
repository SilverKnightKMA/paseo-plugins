import type { PluginClientContext } from "@getpaseo/plugin/client";
import { TaskDecisionsPanel } from "./client/panel.js";

export default function contribute(client: PluginClientContext) {
  // #244 lesson: guard every registration — one throw must not kill the plugin.
  const guard = <T,>(tag: string, fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (err) {
      console.error(`[task-decisions] ${tag} failed:`, err);
      return undefined;
    }
  };

  guard("addWorkspacePanel", () =>
    client.addWorkspacePanel({
      id: "task-decisions",
      title: "Task Decisions",
      icon: "ListTodo",
      context: "workspace",
      Component: TaskDecisionsPanel,
    }),
  );

  guard("addCommandCenterItem", () =>
    client.addCommandCenterItem({
      id: "task-decisions-open",
      title: "Task Decisions: pending amend/appeal/cancel cards",
      icon: "ListTodo",
      keywords: ["decision", "decisions", "amend", "appeal", "cancel", "note"],
      context: "workspace",
      onSelect(context_) {
        context_.openPanel("task-decisions");
      },
    }),
  );

  return () => {
    // panels clean up after themselves; nothing started here
  };
}
