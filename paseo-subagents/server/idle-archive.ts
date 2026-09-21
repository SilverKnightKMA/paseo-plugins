/**
 * Idle-archive reminder — plugin port of #129 (pi ext idle-archive.ts),
 * task #141 / plan step 7.
 *
 * Problem: completed subagents pile up in the agent list; the daemon's autoArchive
 * is archive-on-terminal, which is too aggressive (it prevents resume-by-name
 * follow-ups). Design: REMIND, do not auto-archive. Remind the parent when ALL of
 * its children are quiet (not running/initializing/waiting and no attention marker)
 * and the NEWEST child has been idle for at least remindMinutes (default 15).
 *
 * Unlike the pi ext version, the driver runs in the plugin process (daemon-side)
 * and reads record files directly from disk (~/.paseo/agents/<ws>/<id>.json)
 * instead of using `paseo agent list`. Records contain labels/lastStatus/
 * lastActivityAt/attentionTimestamp/archivedAt. Track only this plugin's children
 * (`subagent.parent` label) to avoid duplicate reminders with pi ext, which reminds
 * its own children.
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

/** Fewer idle children than this is not enough clutter to warrant a reminder. */
export const MIN_IDLE_CHILDREN = 3;

/** After one reminder, stay quiet for this interval (re-arm per parent). */
export const ARCHIVE_REMIND_REARM_MS = 60 * 60_000;

export const DEFAULT_REMIND_MINUTES = 15;

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
 * Select the parent's children (`subagent.parent` label), excluding archived ones.
 * spawner: accept only children created by this spawner (default 'paseo-subagents').
 * Pi ext children also have subagent.parent; without this filter, reminders would
 * be duplicated.
 */
export function toIdleChildren(
  records: AgentRecordLite[],
  parentId: string,
  spawner: string = "paseo-subagents",
): IdleChild[] {
  return records
    .filter((r) => r.labels?.["subagent.parent"] === parentId && !r.archivedAt && r.labels?.["subagent.spawner"] === spawner)
    .map((r) => ({
      id: r.id,
      status: r.lastStatus ?? null,
      lastActivityMs: parseMs(r.lastActivityAt),
      // The daemon sets requiresAttention='finished' on EVERY completed one-shot
      // child. That is the state to archive, not a blocker. Only a marker waiting
      // for the parent (unknown/non-terminal reason) blocks the reminder.
      attentionMs: r.attentionReason && TERMINAL_ATTENTION_REASONS.has(r.attentionReason)
        ? null
        : parseMs(r.attentionTimestamp),
    }));
}

/** Pure decision. null = no reminder (fail closed for any unknown value). */
export function shouldRemindIdleArchive(
  children: IdleChild[],
  nowMs: number,
  minutes: number,
  minChildren: number = MIN_IDLE_CHILDREN,
): ArchiveReminder | null {
  if (minutes <= 0) return null;
  if (children.length < minChildren) return null;
  for (const c of children) {
    if (c.status === "running" || c.status === "initializing") return null; // Busy.
    if (c.status === "waiting") return null; // Parked on a question/decision.
    if (c.attentionMs !== null) return null; // Active attention marker.
    if (c.lastActivityMs === null) return null; // Unknown age — do not guess.
  }
  const newest = Math.max(...children.map((c) => c.lastActivityMs as number));
  if (nowMs - newest < minutes * 60_000) return null; // The newest child is still in the grace window.
  const ids = children.map((c) => c.id);
  return { ids, command: `paseo agent archive ${ids.join(" ")}` };
}

/** Remind once per re-arm window: return true if a reminder is allowed now. */
export function reminderArmed(lastRemindMs: number | undefined, nowMs: number): boolean {
  if (lastRemindMs === undefined) return true;
  return nowMs - lastRemindMs >= ARCHIVE_REMIND_REARM_MS;
}
