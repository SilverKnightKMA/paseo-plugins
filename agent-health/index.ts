import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginContext } from "@getpaseo/plugin";
import { GetStateRpc, ZwEventSchema, AgentRowSchema, StuckQueueSchema } from "./rpc.js";
import { HealthPanel } from "./panel.client.js";

interface RawZwEvent {
  ts?: unknown;
  code?: unknown;
  idleMs?: unknown;
  agentId?: unknown;
}

function readZombieWatchdog(limit: number): { events: unknown[]; counts: Record<string, number> } {
  const file = path.join(os.homedir(), ".pi", "agent", "zombie-watchdog.jsonl");
  const events: { ts: string; code: string; idleMs: number | null; agentId: string | null }[] = [];
  const counts: Record<string, number> = {};
  if (!fs.existsSync(file)) {
    return { events, counts };
  }
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  for (const line of lines) {
    try {
      const raw = JSON.parse(line) as RawZwEvent;
      const code = typeof raw.code === "string" ? raw.code : "unknown";
      counts[code] = (counts[code] ?? 0) + 1;
    } catch {
      // Skip malformed line.
    }
  }
  for (const line of lines.slice(-limit)) {
    try {
      const raw = JSON.parse(line) as RawZwEvent;
      events.push({
        ts: typeof raw.ts === "string" ? raw.ts : "",
        code: typeof raw.code === "string" ? raw.code : "unknown",
        idleMs: typeof raw.idleMs === "number" ? raw.idleMs : null,
        agentId: typeof raw.agentId === "string" ? raw.agentId : null,
      });
    } catch {
      // Skip malformed line.
    }
  }
  return { events, counts };
}

function readStuckQueues(): unknown[] {
  const chanDir = path.join(os.homedir(), ".pi", "agent", "subagent-channel");
  const stuck: {
    agentId: string; name: string | null; events: number;
    oldestEventIso: string; ageHours: number;
  }[] = [];
  let names: Record<string, { agentId: string }> = {};
  try {
    names = JSON.parse(fs.readFileSync(path.join(chanDir, "registry.json"), "utf8"));
  } catch {
    // no registry -> names unavailable, still report raw agent ids
  }
  const byAgentId = new Map<string, string>(
    Object.entries(names).map(([n, e]) => [e.agentId, n]),
  );
  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(chanDir, { withFileTypes: true });
  } catch {
    return stuck;
  }
  for (const f of files) {
    if (!f.name.endsWith(".jsonl")) continue;
    const agentId = f.name.replace(/\.jsonl$/, "");
    const full = path.join(chanDir, f.name);
    try {
      const lines = fs.readFileSync(full, "utf8").split("\n").filter((l) => l.trim());
      if (lines.length === 0) continue;
      let oldest = Number.POSITIVE_INFINITY;
      for (const line of lines) {
        try {
          const ts = Date.parse(JSON.parse(line).ts ?? "");
          if (Number.isFinite(ts)) oldest = Math.min(oldest, ts);
        } catch {
          // skip malformed
        }
      }
      if (!Number.isFinite(oldest)) continue;
      const ageHours = (Date.now() - oldest) / 3_600_000;
      if (ageHours < 48) continue;
      stuck.push({
        agentId,
        name: byAgentId.get(agentId) ?? null,
        events: lines.length,
        oldestEventIso: new Date(oldest).toISOString(),
        ageHours: Math.round(ageHours),
      });
    } catch {
      // unreadable file
    }
  }
  stuck.sort((a, b) => b.ageHours - a.ageHours);
  return stuck;
}

export default function contribute(plugin: PluginContext) {
  plugin.handle(GetStateRpc, async (input, context) => {
    const agents: { id: string; status: string | null; provider: string; model: string | null; cwd: string }[] = [];
    try {
      const result = await context.paseo.agents.list();
      for (const entry of result.entries as unknown[]) {
        const e = entry as Record<string, unknown>;
        const a = (e.agent ?? e) as Record<string, unknown>;
        agents.push({
          id: typeof a.id === "string" ? a.id : "(unknown)",
          status: typeof a.status === "string" ? a.status : null,
          provider: typeof a.provider === "string" ? a.provider : "(unknown)",
          model: typeof a.model === "string" ? a.model : null,
          cwd: typeof a.cwd === "string" ? a.cwd : "",
        });
      }
    } catch (err) {
      agents.push({
        id: "(error)",
        status: null,
        provider: `agent list failed: ${String(err).slice(0, 120)}`,
        model: null,
        cwd: "",
      });
    }
    const { events, counts } = readZombieWatchdog(input.limit);
    return {
      agents,
      zwEvents: ZwEventSchema.array().parse(events),
      zwCounts: counts,
      stuckQueues: StuckQueueSchema.array().parse(readStuckQueues()),
      generatedAt: new Date().toISOString(),
    };
  });

  plugin.addWorkspacePanel({
    id: "agent-health",
    title: "Agent Health",
    icon: "Activity",
    context: "workspace",
    Component: HealthPanel,
  });

  plugin.addCommandCenterItem({
    id: "agent-health-open",
    title: "Agent Health: agents & zombie-watchdog",
    icon: "Activity",
    keywords: ["zombie", "watchdog", "health", "agents"],
    context: "workspace",
    onSelect(context_) {
      context_.openPanel("agent-health");
    },
  });

  return () => {};
}
