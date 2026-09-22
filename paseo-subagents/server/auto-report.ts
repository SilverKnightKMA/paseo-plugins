/**
 * #225 auto-report backstop — the deterministic reply guarantee.
 *
 * Evidence (2026-09-22): the three provider report paths each have a hole —
 *  - pi children have the ungated MCP reply tool but trivially end in plain
 *    text (F10 smoke scouts returned their token as text and never called it);
 *  - claude children get the MCP tool but it is permission-gated (F11 smoke:
 *    the tool_result hung 71 minutes until the permission stream died);
 *  - codex children honestly report "tool not available" and their final text
 *    goes nowhere.
 *
 * This module makes delivery a property of the SYSTEM, not of the model: every
 * child this plugin spawns is watched; when its disk record reaches a terminal
 * state without a reply_to_parent delivery, the plugin fetches the child's
 * timeline through the daemon API (provider-agnostic), extracts the last
 * assistant_message, and delivers it as a [child-report] envelope with an
 * explicit [auto-report] marker. Children that DO report are marked at deliver
 * time (DeliverFn meta.callerAgentId) and never pinged.
 *
 * State is process-RAM only: the watch list is populated at spawn time, so a
 * plugin restart starts with an empty list and cannot re-send anything.
 */

/** A child the plugin spawned and whose terminal-without-report moment we await. */
export interface WatchedChild {
	agentId: string;
	parentId: string;
	title: string;
	role?: string;
	providerModel?: string;
	spawnedAt: number;
}

/** Terminal slice of a paseo agent disk record (idle-archive.ts readAgentRecords shape). */
export interface TerminalRecordSlice {
	lastStatus?: string | null;
	archivedAt?: string | null;
}

/** A record is terminal when it settled (idle/error/closed) or was archived. */
export function isTerminal(record: TerminalRecordSlice): boolean {
	if (record.archivedAt) return true;
	const s = record.lastStatus;
	return s === "idle" || s === "error" || s === "closed";
}

/** Last assistant_message text from a timeline items array (AgentTimelineItem). */
export function lastAssistantText(items: unknown[]): string | null {
	let last: string | null = null;
	for (const item of items) {
		if (
			item !== null &&
			typeof item === "object" &&
			(item as { type?: unknown }).type === "assistant_message" &&
			typeof (item as { text?: unknown }).text === "string"
		) {
			last = (item as { text: string }).text;
		}
	}
	return last;
}

/** Cap captured text so a runaway child cannot flood the parent's chat. */
export const AUTO_REPORT_MAX_CHARS = 4000;

export function truncateText(text: string, max = AUTO_REPORT_MAX_CHARS): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n…(truncated ${text.length - max} chars)`;
}

/**
 * The envelope: keeps the [child-report] prefix (MARKERS contract) and the #226
 * identity header, appends an explicit [auto-report] marker line so the parent
 * can tell a tool delivery from a system capture.
 */
export function autoReportEnvelope(child: WatchedChild, finalText: string | null): string {
	const parts = [child.role, child.agentId.slice(0, 8), child.providerModel].filter(Boolean);
	const header = parts.length > 0 ? `${child.title} (${parts.join(", ")})` : child.title;
	const trimmed = finalText?.trim();
	const body = trimmed ? truncateText(trimmed) : "(no assistant text found in the child's timeline)";
	return `[child-report] ${header}: ${body}\n[auto-report] child finished without calling reply_to_parent — text captured from its timeline by the plugin`;
}
