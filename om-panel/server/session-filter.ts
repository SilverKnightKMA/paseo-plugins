/**
 * session-filter — shared session visibility for the picker pairs.
 *
 * SYNCED FILE: this exact copy lives in task/, snip/ (general pair) and
 * om-panel/, om-status/ (OM pair). check-shared-ui.py pins all four copies
 * identical — edit one, copy to the rest, never let them drift.
 *
 * Visibility rule (user decision 2026-09-13):
 *   hidden ⇔ archivedAt set (user pressed Archive in the app — source of truth)
 *         ∨ internal true (system-internal agents never appear)
 *         ∨ subagent-labeled (subagent.role / subagent.parent / paseo.parent-agent-id)
 *   Sessions whose agent record no longer exists are hidden too: the picker
 *   is agent-driven, a deleted record has nothing to show.
 *
 * Pairs:
 *   general (task, snip)          → visibleGeneral: every visible session of the ws
 *   om      (om-panel, om-status) → visibleOm: general ∩ owns a .memory/<sid>/ dir
 * Pair identity is by construction: both members of a pair call the SAME
 * function below on the SAME agent list.
 */

export interface FilterAgentLike {
  id?: string;
  workspaceId?: string | null;
  status?: string | null;
  updatedAt?: string | null;
  lastUserMessageAt?: string | null;
  title?: string | null;
  archivedAt?: string | null;
  labels?: Record<string, unknown> | null;
  internal?: boolean | null;
  cwd?: string | null;
  runtimeInfo?: { sessionId?: string | null } | null;
}

export function isSubagentAgent(a: FilterAgentLike): boolean {
  const labels = a.labels;
  if (!labels) return false;
  return Boolean(
    labels["subagent.role"] ?? labels["subagent.parent"] ?? labels["paseo.parent-agent-id"],
  );
}

export function isHiddenSession(a: FilterAgentLike): boolean {
  return a.archivedAt != null || a.internal === true || isSubagentAgent(a);
}

/**
 * Unwrap daemon `context.paseo.agents.list()` result: entries are
 * {agent: {...}} wrappers, not flat agent records. Shared since v1.0.50
 * (#68) — task/snip/plan used to hand-copy this and the plan port drifted
 * (flat-shape unwrap → 0 agents → empty picker chips).
 */
export function unwrapAgents(entries: unknown[]): FilterAgentLike[] {
  const out: FilterAgentLike[] = [];
  for (const e of entries) {
    const inner = (e as { agent?: unknown }).agent;
    if (inner && typeof inner === "object") out.push(inner as FilterAgentLike);
  }
  return out;
}

export function activityOf(a: FilterAgentLike): number {
  return Math.max(
    Date.parse(a.lastUserMessageAt ?? "") || 0,
    Date.parse(a.updatedAt ?? "") || 0,
  );
}

export interface VisibleSession {
  sessionId: string;
  agentId: string;
  title: string | null;
  status: string | null;
  activeAt: number;
}

/** General pair (task/snip): all visible sessions of the workspace, newest first. */
export function visibleGeneral(
  agents: FilterAgentLike[],
  inWorkspace: (a: FilterAgentLike) => boolean,
): VisibleSession[] {
  const out: VisibleSession[] = [];
  for (const a of agents) {
    if (isHiddenSession(a) || !inWorkspace(a)) continue;
    const sid = a.runtimeInfo?.sessionId;
    if (!sid || !a.id) continue;
    out.push({
      sessionId: sid,
      agentId: a.id,
      title: a.title ?? null,
      status: a.status ?? null,
      activeAt: activityOf(a),
    });
  }
  out.sort((x, y) => y.activeAt - x.activeAt);
  return out;
}

/** OM pair (om-panel/om-status): general ∩ sessions that own a .memory dir. */
export function visibleOm(
  agents: FilterAgentLike[],
  inWorkspace: (a: FilterAgentLike) => boolean,
  memorySessionIds: Set<string>,
): VisibleSession[] {
  return visibleGeneral(agents, inWorkspace).filter((s) => memorySessionIds.has(s.sessionId));
}
