import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginContext } from "@getpaseo/plugin";
import { z } from "zod";
import { GetStateRpc, GetZwAlertRpc, ZwEventSchema, AgentRowSchema, StuckQueueSchema } from "./rpc.js";
import { HealthPanel } from "./panel.client.js";
import { SubagentNoticeCard, type SubagentNoticeData } from "./subagent-notice.client.js";
import { MutedAbortCard } from "./muted-abort.client.js";
import { startZwLive } from "./zw-pill.client.js";

interface RawZwEvent {
  ts?: unknown;
  code?: unknown;
  idleMs?: unknown;
  agentId?: unknown;
}

type ZwEventLike = { ts: string; code: string; idleMs?: number | null; agentId?: string | null };

function readZombieWatchdog(limit: number): { events: ZwEventLike[]; counts: Record<string, number> } {
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

  plugin.addClientSide((client) => startZwLive(client));

  plugin.handle(GetZwAlertRpc, async (input) => {
    const FRESH_MS = 5 * 60_000;
    const ALERT_CODES = new Set(["zombie", "b2-settle-lost"]);
    const { events } = readZombieWatchdog(1);
    const last = events[events.length - 1];
    if (!last) {
      return { alert: false, ts: null, code: null, idleMs: null, agentId: null, mine: false };
    }
    const age = Date.now() - Date.parse(last.ts);
    const alert = Number.isFinite(age) && age >= 0 && age < FRESH_MS && ALERT_CODES.has(last.code);
    return {
      alert,
      ts: last.ts,
      code: last.code,
      idleMs: last.idleMs,
      agentId: last.agentId,
      mine: Boolean(input.agentId && last.agentId === input.agentId),
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

  // ── subagent notice cards ─────────────────────────────────────────────
  // The subagent channel delivers <subagent-message …> blocks as plain
  // user-message text; the app prints the raw tags + duplicated UUIDs.
  // Transform (render-layer only) replaces them with a clean plugin card.
  plugin.addTimelineTransformer({
    id: "subagent-report-transformer",
    query: { itemType: "user_message" },
    transform: ({ item }) => {
      if (item.type !== "user_message") return undefined;
      // một user message có thể chứa nhiều envelope (drain gộp bằng "\n\n")
      const parsedAll = parseAllSubagentNotices(item.text);
      if (parsedAll.length === 0) return undefined;
      return {
        items: parsedAll.map((parsed) => ({
          type: "plugin" as const,
          kind: "subagent-report",
          version: 1,
          data: parsed,
        })),
      };
    },
  });

  plugin.addTimelineRenderer({
    kind: "subagent-report",
    version: 1,
    schema: z.object({
      role: z.string(),
      kind: z.string(),
      agentId: z.string(),
      name: z.string().nullable(),
      body: z.string(),
      tone: z.enum(["ok", "info", "warn"]),
    }),
    Component: SubagentNoticeCard,
  });

  // ── muted abort card ─────────────────────────────────────────────────
  // "[System Error] This operation was aborted (stopReason=error …)" —
  // node-fetch AbortError bị adapter pi gán nhầm stopReason=error vì signal
  // user-abort chưa kịp được đánh dấu. Chỉ hiển thị; transcript giữ nguyên.
  plugin.addTimelineTransformer({
    id: "muted-abort-transformer",
    query: { itemType: "error" },
    transform: ({ item }) => {
      if (item.type !== "error") return undefined;
      if (!/operation was aborted/i.test(item.message)) return undefined;
      return { items: [{ type: "plugin" as const, kind: "muted-abort", version: 1, data: { message: item.message } }] };
    },
  });

  plugin.addTimelineRenderer({
    kind: "muted-abort",
    version: 1,
    schema: z.object({ message: z.string() }),
    Component: MutedAbortCard,
  });

  return () => {};
}

const SUBAGENT_RE =
  /^<subagent-message from="([0-9a-f-]{36})" role="([\w-]+)" kind="([\w-]+)">\n?([\s\S]*?)\n?<\/subagent-message>$/;

const SUBAGENT_BLOCK_RE =
  /<subagent-message from="[0-9a-f-]{36}" role="[\w-]+" kind="[\w-]+">[\s\S]*?<\/subagent-message>/g;

/** Split a user message into envelopes, parse each; [] = not ours. */
function parseAllSubagentNotices(text: string): SubagentNoticeData[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith("<subagent-message")) return [];
  const blocks = trimmed.match(SUBAGENT_BLOCK_RE) ?? [];
  if (blocks.length === 0) return [];
  // mọi block phải khớp format; nếu chỉ một phần khớp thì để nguyên pass-through
  const parsed = blocks.map((b) => parseSubagentNotice(b));
  return parsed.every((p) => p !== null) ? (parsed as SubagentNoticeData[]) : [];
}

/** Parse + clean a <subagent-message> block into card data; null = not ours. */
function parseSubagentNotice(text: string): SubagentNoticeData | null {
  const m = SUBAGENT_RE.exec(text.trim());
  if (!m) return null;
  const [, agentId, role, kindTag, rawBody] = m;
  let body = rawBody.trim();
  let tone: SubagentNoticeData["tone"] = "info";
  let label = kindTag;
  const tag = /^\[([a-z][a-z-]*)\]\s*/i.exec(body);
  if (tag) {
    label = tag[1].toLowerCase();
    body = body.slice(tag[0].length);
    if (label === "auto-report") tone = "ok";
    else if (label === "channel-nack") tone = "warn";
  }
  let name: string | null = null;
  const nm = /Subagent [\w-]+ "([^"]+)" \(([0-9a-f-]{36})\)/.exec(body);
  if (nm) {
    name = nm[1];
    body = body.replace(` "${nm[1]}" (${nm[2]})`, ` "${nm[1]}"`); // bỏ UUID lặp trong thân
  }
  return { role, kind: label, agentId, name, body, tone };
}
