/**
 * Parser for the engine lessons block (#110). Pure — no RN/node imports so
 * both the client transformer and any test harness can run it directly.
 *
 * MARKERS.md live marker: the block header is emitted by pi-config
 * extensions/_shared/lessons-core.ts renderBlock ("Lessons from past
 * sessions (global tier, newest last, auto-injected — ...):").
 */
export const LESSONS_PREFIX = "Lessons from past sessions";

export const LESSON_LINE_RE = /^\[\d{4}-\d{2}-\d{2}\]\[[^\]]+\]\s+/;

export type LessonsBlockInfo = {
	/** lessons listed in the injected block */
	count: number;
	/** engine inject window (LESSONS_MAX_AGE_DAYS, default 30) */
	maxAgeDays: number;
}

export function parseLessonsBlock(text: string): LessonsBlockInfo | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith(LESSONS_PREFIX)) return null;
	const lines = trimmed.split("\n");
	const header = lines[0] ?? "";
	// header variants seen: "(global tier, newest last, auto-injected — these cost nothing to keep):"
	const ageMatch = /≤\s*(\d+)\s*(?:d|ngày|days?)|(\d+)\s*(?:d|days?)\s*(?:old|max)/i.exec(header);
	const maxAgeDays = Number(ageMatch?.[1] ?? ageMatch?.[2] ?? 30);
	const count = lines.filter((l) => LESSON_LINE_RE.test(l.trim())).length;
	return { count, maxAgeDays: Math.max(1, Math.min(365, maxAgeDays)) };
}
