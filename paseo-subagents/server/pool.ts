/**
 * spawn_pool — port the pi spawn_pool tool to the plugin door (#145 / plan step 10).
 * Fan out to 2-12 role-typed children, with at most `concurrency` (1-4, default 4)
 * running in parallel. DETACH — return {poolId} immediately; ONE aggregate
 * [pool-report] envelope reaches the parent when every child is terminal.
 *
 * Pure module (no I/O): validate, batch, aggregate, and decide delivery.
 * The watcher (disk + timer) lives in index.server.ts.
 */

export interface PoolItem {
  role: string;
  task: string;
  name?: string;
}

export interface PoolSpawned {
  agentId: string;
  item: PoolItem;
}

export interface PoolChildState {
  id: string;
  lastStatus: string | null;
  archivedAt?: string | null;
}

export interface ValidatedPool {
  items: PoolItem[];
  concurrency: number;
}

export const MAX_POOL_ITEMS = 12;
export const MIN_POOL_ITEMS = 2;
export const MAX_POOL_CONCURRENCY = 4;
/** Pool terminal states: idle (completed cleanly) or error. */
export const TERMINAL_STATUSES = new Set(["idle", "error"]);
/** Maximum pool age before a partial flush — prevents immortal pools. */
export const POOL_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export function validatePoolArgs(
  items: unknown,
  concurrency: unknown,
): { ok: true; pool: ValidatedPool } | { ok: false; error: string } {
  if (!Array.isArray(items)) return { ok: false, error: "invalid arguments: 'items' (array) is required" };
  if (items.length < MIN_POOL_ITEMS || items.length > MAX_POOL_ITEMS) {
    return { ok: false, error: `pool needs ${MIN_POOL_ITEMS}-${MAX_POOL_ITEMS} items, got ${items.length}` };
  }
  const clean: PoolItem[] = [];
  for (const [i, raw] of items.entries()) {
    if (typeof raw !== "object" || raw === null) return { ok: false, error: `items[${i}] must be an object` };
    const it = raw as { role?: unknown; task?: unknown; name?: unknown };
    if (typeof it.role !== "string" || it.role.length === 0) return { ok: false, error: `items[${i}].role (non-empty string) is required` };
    if (typeof it.task !== "string" || it.task.length === 0) return { ok: false, error: `items[${i}].task (non-empty string) is required` };
    clean.push({ role: it.role, task: it.task, name: typeof it.name === "string" && it.name ? it.name : undefined });
  }
  const c = typeof concurrency === "number" && Number.isFinite(concurrency) ? Math.floor(concurrency) : MAX_POOL_CONCURRENCY;
  return { ok: true, pool: { items: clean, concurrency: Math.min(Math.max(c, 1), MAX_POOL_CONCURRENCY) } };
}

/** Split items into sequential batches, each with at most `concurrency` parallel items. */
export function scheduleBatches<T>(items: T[], concurrency: number): T[][] {
  const size = Math.min(Math.max(Math.floor(concurrency) || 1, 1), MAX_POOL_CONCURRENCY);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function makePoolId(): string {
  return `pool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function childTerminal(child: PoolChildState): boolean {
  if (child.archivedAt) return true; // Archived is always terminal.
  return child.lastStatus !== null && TERMINAL_STATUSES.has(child.lastStatus);
}

export function allTerminal(children: PoolChildState[]): boolean {
  return children.length > 0 && children.every(childTerminal);
}

export interface AggregateLine {
  label: string;
  state: string;
}

/** ONE aggregate message for the parent: all children terminal, split into ok (idle) and failed. */
export function aggregatePoolReport(
  poolId: string,
  children: PoolChildState[],
  labelFor: (child: PoolChildState) => AggregateLine,
): string {
  const idle = children.filter((c) => !c.archivedAt && c.lastStatus === "idle");
  const failed = children.filter((c) => c.archivedAt || c.lastStatus === "error");
  const lines = children.map((c) => {
    const { label, state } = labelFor(c);
    return `- ${label}: ${state}`;
  });
  return (
    `[pool-report] pool ${poolId} complete: ${children.length} children terminal ` +
    `(ok ${idle.length}, failed/archived ${failed.length}). Each child's detailed report arrived separately via [child-report].\n` +
    lines.join("\n")
  );
}
