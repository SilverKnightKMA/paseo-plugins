/**
 * Idle-archive — plugin port of #129 (pi ext idle-archive.ts), task #141 / plan step 7.
 *
 * #224 (2026-09-22): the REMIND design is RETIRED. Evidence: e2e-m130-codex2
 * (codex parent) received the [housekeeping] reminder 10x over 7h and every time
 * answered "Unable to archive ... CLI path unresponsive" — codex/claude parents
 * have NO paseo CLI, so they can never comply: an infinite nag loop that burns
 * foreign-provider tokens while children stay unarchived. Archiving is plumbing,
 * and plumbing belongs to the system, not the model.
 *
 * New design: the plugin archives idle children DIRECTLY through its in-process
 * paseo API (agents.ref(id).archive()) — no model, no harness, no CLI. Soft-delete
 * semantics are preserved end to end (daemon unarchives automatically when a
 * message arrives), so resume-by-name follow-ups keep working. The decision is
 * per-child and conservative: terminal status (idle/error/closed), no active
 * attention marker, known last activity, quiet for at least N minutes (default 15,
 * 0 = disabled). Only this plugin's children (subagent.spawner label) are ever
 * touched — pi-ext children stay with their own owner.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface AgentRecordLite {
  id: string;
  title?: string;
  labels?: Record<string, string>;
  lastStatus?: string | null;
  lastActivityAt?: string;
  attentionTimestamp?: string | null;
  /** 'finished'/'error' = terminal (daemon enum), not waiting for the parent. */
  attentionReason?: string | null;
  archivedAt?: string | null;
}

/** Attention reasons that are TERMINAL states — the child has stopped and is not waiting for anyone. */
export const TERMINAL_ATTENTION_REASONS = new Set(["finished", "error"]);

export interface IdleChild {
  id: string;
  status: string | null;
  /** Epoch milliseconds of the last activity; null = unknown. */
  lastActivityMs: number | null;
  /** Epoch milliseconds of the active attention/park marker; null = none. */
  attentionMs: number | null;
}

export interface ArchiveReminder {
  ids: string[];
  command: string;
}

export const DEFAULT_REMIND_MINUTES = 15;

/** A child the plugin may archive itself (soft delete). */
export interface ArchivableChild {
  id: string;
  title: string | undefined;
  parentId: string;
  idleMinutes: number;
}

function parseMs(v: unknown): number | null {
  if (typeof v !== "string" || v.length === 0) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** Scan every `<ws>/<id>.json` under agentsRoot (skip invalid JSON or unexpected shapes). */
export function readAgentRecords(agentsRoot: string): AgentRecordLite[] {
  if (!existsSync(agentsRoot)) return [];
  const out: AgentRecordLite[] = [];
  for (const ws of readdirSync(agentsRoot, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const wsDir = join(agentsRoot, ws.name);
    for (const f of readdirSync(wsDir, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(readFileSync(join(wsDir, f.name), "utf-8")) as Record<string, unknown>;
        if (typeof raw.id !== "string") continue;
        out.push({
          id: raw.id,
          title: typeof raw.title === "string" ? raw.title : undefined,
          labels: (raw.labels && typeof raw.labels === "object" ? raw.labels : undefined) as Record<string, string> | undefined,
          lastStatus: (typeof raw.lastStatus === "string" ? raw.lastStatus : null),
          lastActivityAt: typeof raw.lastActivityAt === "string" ? raw.lastActivityAt : undefined,
          attentionTimestamp: typeof raw.attentionTimestamp === "string" ? raw.attentionTimestamp : null,
          attentionReason: typeof raw.attentionReason === "string" ? raw.attentionReason : null,
          archivedAt: typeof raw.archivedAt === "string" ? raw.archivedAt : null,
        });
      } catch {
        // Partially written record — skip this file without crashing the scanner.
      }
    }
  }
  return out;
}

/**
 * Pure selection (#224): every plugin-spawned child that is terminal, quiet,
 * unarchived and past the grace window — across ALL parents, decided per child.
 * Fail closed for any unknown value: running/waiting/initializing status, an
 * active non-terminal attention marker, an unknown last-activity age, an
 * already-archived record, or a child spawned by another owner all disqualify.
 */
export function selectAutoArchivable(
  records: AgentRecordLite[],
  nowMs: number,
  minutes: number,
  spawner: string = "paseo-subagents",
): ArchivableChild[] {
  if (minutes <= 0) return [];
  const out: ArchivableChild[] = [];
  for (const r of records) {
    if (r.archivedAt) continue;
    if (r.labels?.["subagent.spawner"] !== spawner) continue;
    const parentId = r.labels?.["subagent.parent"];
    if (!parentId) continue;
    if (r.lastStatus !== "idle" && r.lastStatus !== "error" && r.lastStatus !== "closed") continue;
    // A terminal attention marker (finished/error) is the daemon's normal settled
    // stamp on one-shot children — archiveable. Any OTHER active marker means the
    // child is waiting on its parent: leave it.
    if (r.attentionTimestamp && !(r.attentionReason && TERMINAL_ATTENTION_REASONS.has(r.attentionReason))) continue;
    const lastMs = parseMs(r.lastActivityAt);
    if (lastMs === null) continue; // Unknown age — do not guess.
    const idleMs = nowMs - lastMs;
    if (idleMs < minutes * 60_000) continue;
    out.push({ id: r.id, title: r.title, parentId, idleMinutes: Math.floor(idleMs / 60_000) });
  }
  return out;
}
