import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { GetStateRpc, GetZwAlertRpc, ZwEventSchema, StuckQueueSchema, SseProbeSchema } from "../shared/rpc.js";

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

function readSseProbe(limit: number): { present: boolean; total: number; byKind: Record<string, number>; lastTs: string | null; recent: Array<{ ts: string; model: string; stopReason: string; kind: string; errorMessage: string; turnDurMs: number; contentLen: number }> } {
  const jsonl = path.join(os.homedir(), ".pi", "agent", "sse-probe.jsonl");
  const summaryFile = path.join(os.homedir(), ".pi", "agent", "sse-probe.json");
  if (!fs.existsSync(jsonl)) {
    return { present: false, total: 0, byKind: {}, lastTs: null, recent: [] };
  }
  let total = 0;
  let byKind: Record<string, number> = {};
  let lastTs: string | null = null;
  try {
    const summary = JSON.parse(fs.readFileSync(summaryFile, "utf8")) as { total?: number; byKind?: Record<string, number>; lastTs?: string | null };
    total = typeof summary.total === "number" ? summary.total : 0;
    byKind = summary.byKind && typeof summary.byKind === "object" ? summary.byKind : {};
    lastTs = typeof summary.lastTs === "string" ? summary.lastTs : null;
  } catch {
    // summary missing/corrupt — derive from the tail below
  }
  const recent: Array<{ ts: string; model: string; stopReason: string; kind: string; errorMessage: string; turnDurMs: number; contentLen: number }> = [];
  try {
    const lines = fs.readFileSync(jsonl, "utf8").split("\n").filter((l) => l.trim());
    if (total === 0) total = lines.length;
    for (const line of lines.slice(-limit)) {
      try {
        const r = JSON.parse(line) as Record<string, unknown>;
        recent.push({
          ts: typeof r.ts === "string" ? r.ts : "",
          model: typeof r.model === "string" ? r.model : "(unknown)",
          stopReason: typeof r.stopReason === "string" ? r.stopReason : "",
          kind: typeof r.kind === "string" ? r.kind : "unknown",
          errorMessage: typeof r.errorMessage === "string" ? r.errorMessage : "",
          turnDurMs: typeof r.turnDurMs === "number" ? r.turnDurMs : 0,
          contentLen: typeof r.contentLen === "number" ? r.contentLen : 0,
        });
      } catch {
        // Skip malformed line.
      }
    }
    if (Object.keys(byKind).length === 0) {
      for (const r of recent) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    }
    if (!lastTs && recent.length > 0) lastTs = recent[recent.length - 1].ts;
  } catch {
    // unreadable jsonl — summary alone
  }
  return { present: true, total, byKind, lastTs, recent };
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

export async function healthStateHandler(input: RpcInput<typeof GetStateRpc>, context: PluginHandlerContext) {

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
      sse: SseProbeSchema.parse(readSseProbe(input.limit)),
      stuckQueues: StuckQueueSchema.array().parse(readStuckQueues()),
      generatedAt: new Date().toISOString(),
    };
}

export async function zwAlertHandler(input: RpcInput<typeof GetZwAlertRpc>) {

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
      idleMs: last.idleMs ?? null,
      agentId: last.agentId ?? null,
      mine: Boolean(input.agentId && last.agentId === input.agentId),
    };
}
