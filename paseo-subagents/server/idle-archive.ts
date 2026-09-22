/**
 * Idle-archive — two tiers (user-approved design 2026-09-22, task #230).
 *
 * History: #129/#141 shipped a REMIND-only design that nagged parents into
 * running a CLI they do not have (codex parent 429eb27a got the reminder 10x,
 * answered "Unable to archive — CLI path unresponsive" every time). #224
 * flipped to AUTO-only at 15 minutes, which the user rejected: the MODEL must
 * be the deciding factor. The shipped truth (verified via git + transcripts
 * 2026-09-22): remind-only ran v1.0.70–v1.0.89, auto-only ran v1.0.90, and
 * the daemon's own autoArchive (archive-on-terminal) was always rejected as
 * too aggressive (kills resume-by-name). Two tiers never coexisted — until now.
 *
 * Tier 1 (remind): when a plugin-spawned child is settled and idle for ≥
 * remindAfterMinutes (default 30, 0 = off), the parent gets ONE [housekeeping]
 * message per CHILD (never repeated — the reminded set persists on disk across
 * restarts, so #141's re-nag loop cannot return). The message tells the parent
 * to decide via the archive_subagent TOOL (works for every provider), not a CLI.
 *
 * Tier 2 (force): any plugin-spawned child still unarchived after
 * archiveAfterDays (default 7, 0 = off) is archived by the plugin itself —
 * soft delete: the daemon auto-unarchives when a message arrives, so
 * resume-by-name follow-ups keep working. The daemon's archive-on-terminal
 * autoArchive is deliberately NOT used.
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

/** Tier 1: remind the parent once per child after this many idle minutes (0 = off). */
export const DEFAULT_REMIND_AFTER_MINUTES = 30;
/** Tier 2: plugin force-archives a child after this many days unarchived (0 = off). */
export const DEFAULT_ARCHIVE_AFTER_DAYS = 7;
/** Hard ceiling on tier 2 — a force window longer than 90 days makes no sense. */
export const MAX_ARCHIVE_AFTER_DAYS = 90;

/** A child whose parent should be reminded (tier 1) — decided per child, once. */
export interface RemindableChild {
  id: string;
  title: string | undefined;
  role: string | undefined;
  parentId: string;
  idleMinutes: number;
}

/** A child the plugin may archive itself (tier 2, soft delete). */
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
 * Tier-1 selection: every plugin-spawned child that is settled, quiet, unarchived,
 * past the remind threshold and NOT yet reminded (alreadyReminded is the persisted
 * set). Same eligibility gates as selectAutoArchivable — fail closed on any
 * unknown value — so a child is only ever advertised as archivable once it is
 * genuinely settled. Group by parentId at send time; each child appears in at
 * most ONE reminder ever.
 */
export function selectRemindable(
  records: AgentRecordLite[],
  nowMs: number,
  minutes: number,
  alreadyReminded: ReadonlySet<string>,
  spawner: string = "paseo-subagents",
): RemindableChild[] {
  if (minutes <= 0) return [];
  const out: RemindableChild[] = [];
  for (const r of records) {
    if (r.archivedAt) continue;
    if (alreadyReminded.has(r.id)) continue;
    if (r.labels?.["subagent.spawner"] !== spawner) continue;
    const parentId = r.labels?.["subagent.parent"];
    if (!parentId) continue;
    if (r.lastStatus !== "idle" && r.lastStatus !== "error" && r.lastStatus !== "closed") continue;
    if (r.attentionTimestamp && !(r.attentionReason && TERMINAL_ATTENTION_REASONS.has(r.attentionReason))) continue;
    const lastMs = parseMs(r.lastActivityAt);
    if (lastMs === null) continue;
    const idleMs = nowMs - lastMs;
    if (idleMs < minutes * 60_000) continue;
    out.push({ id: r.id, title: r.title, role: r.labels?.["subagent.role"], parentId, idleMinutes: Math.floor(idleMs / 60_000) });
  }
  return out;
}

/** Self-describing tier-1 message (English by repo convention #172): the parent decides via TOOLS, no CLI. */
export function formatHousekeeping(children: RemindableChild[], remindAfterMinutes: number, archiveAfterDays: number): string {
  const lines = children.map(
    (c) => `- ${c.id.slice(0, 8)} · ${c.role ?? "unknown-role"} · ${c.title ?? "untitled"} · idle ${c.idleMinutes}m`,
  );
  return (
    `[housekeeping] ${children.length} of your subagents have been settled and idle for ≥${remindAfterMinutes} minutes:\n` +
    lines.join("\n") +
    `\nYou decide: call the archive_subagent tool with these agentIds to archive them now (soft delete — messaging a child auto-unarchives it), ` +
    `or leave them. They will be archived automatically after ${archiveAfterDays} day(s). Use list_subagents to review your subagents at any time.`
  );
}

/**
 * Tier-2 selection (#224/#230): every plugin-spawned child that is terminal, quiet,
 * unarchived and past the force window — across ALL parents, decided per child.
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
