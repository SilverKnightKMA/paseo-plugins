/**
 * Idle-archive reminder — plugin port của #129 (pi ext idle-archive.ts),
 * task #141 / plan step 7.
 *
 * Pain: subagent đã xong chất đống trong agent list; autoArchive của daemon
 * là archive-on-terminal — quá gắt (giết resume-by-name follow-ups).
 * Thiết kế: REMIND, không tự archive. Nhắc parent khi MỌI con của parent đó
 * đều yên tĩnh (không running/initializing/waiting, không attention marker)
 * và con MỚI NHẤT đã idle ≥ remindMinutes (mặc định 15).
 *
 * Khác bản pi ext: driver chạy trong plugin process (daemon-side), đọc
 * thẳng record file từ đĩa (~/.paseo/agents/<ws>/<id>.json) thay vì CLI
 * `paseo agent list` — record có đủ labels/lastStatus/lastActivityAt/
 * attentionTimestamp/archivedAt. Chỉ track con của plugin (label
 * `subagent.parent`) để không đôi reminder với pi ext (nó tự nhắc con của nó).
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
  /** 'finished'/'error' = terminal (daemon enum) — không phải đang chờ parent. */
  attentionReason?: string | null;
  archivedAt?: string | null;
}

/** Attention reasons là trạng thái TERMAL — con đã dứt, không đợi ai. */
export const TERMINAL_ATTENTION_REASONS = new Set(["finished", "error"]);

export interface IdleChild {
  id: string;
  status: string | null;
  /** ms epoch của hoạt động cuối; null = không biết. */
  lastActivityMs: number | null;
  /** ms epoch của attention/park marker đang mở; null = không có. */
  attentionMs: number | null;
}

export interface ArchiveReminder {
  ids: string[];
  command: string;
}

/** Ít hơn mức này con idle thì list chưa đủ đông để đáng nhắc. */
export const MIN_IDLE_CHILDREN = 3;

/** Sau khi nhắc 1 lần, im tới khi đủ khoảng này trôi qua (re-arm theo parent). */
export const ARCHIVE_REMIND_REARM_MS = 60 * 60_000;

export const DEFAULT_REMIND_MINUTES = 15;

function parseMs(v: unknown): number | null {
  if (typeof v !== "string" || v.length === 0) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** Quẽt mọi `<ws>/<id>.json` dưới agentsRoot (bỏ JSON hỏng / shape lạ). */
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
        // record hỏng nửa chừng — bỏ qua file này, scanner không chết
      }
    }
  }
  return out;
}

/** Lọc con của parent (label `subagent.parent`), bỏ con đã archive. */
export function toIdleChildren(records: AgentRecordLite[], parentId: string): IdleChild[] {
  return records
    .filter((r) => r.labels?.["subagent.parent"] === parentId && !r.archivedAt)
    .map((r) => ({
      id: r.id,
      status: r.lastStatus ?? null,
      lastActivityMs: parseMs(r.lastActivityAt),
      // Daemon dán requiresAttention='finished' lên MỌI con one-shot đã xong —
      // đó chính là trạng thái cần archive, không phải blocker. Chỉ marker
      // đang chờ parent (reason lạ/không terminal) mới chặn reminder.
      attentionMs: r.attentionReason && TERMINAL_ATTENTION_REASONS.has(r.attentionReason)
        ? null
        : parseMs(r.attentionTimestamp),
    }));
}

/** Quyết định thuần. null = không nhắc (fail-closed với mọi giá trị lạ). */
export function shouldRemindIdleArchive(
  children: IdleChild[],
  nowMs: number,
  minutes: number,
  minChildren: number = MIN_IDLE_CHILDREN,
): ArchiveReminder | null {
  if (minutes <= 0) return null;
  if (children.length < minChildren) return null;
  for (const c of children) {
    if (c.status === "running" || c.status === "initializing") return null; // đang bận
    if (c.status === "waiting") return null; // parked trên câu hỏi/decision
    if (c.attentionMs !== null) return null; // attention marker đang mở
    if (c.lastActivityMs === null) return null; // tuổi không rõ — không đoán
  }
  const newest = Math.max(...children.map((c) => c.lastActivityMs as number));
  if (nowMs - newest < minutes * 60_000) return null; // con mới nhất còn trong grace window
  const ids = children.map((c) => c.id);
  return { ids, command: `paseo agent archive ${ids.join(" ")}` };
}

/** Nhắc 1 lần/re-arm-window: trả về true nếu được phép nhắc bây giờ. */
export function reminderArmed(lastRemindMs: number | undefined, nowMs: number): boolean {
  if (lastRemindMs === undefined) return true;
  return nowMs - lastRemindMs >= ARCHIVE_REMIND_REARM_MS;
}
