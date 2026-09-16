import { readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { RpcInput } from "@getpaseo/plugin";
import { GetLessonsStateRpc, type LessonRow } from "../shared/rpc.js";

/**
 * Read-only view of ~/.pi/agent/lessons.md — the single source the engine
 * extension already owns (parse/trim/inject happen engine-side in
 * pi-config extensions/_shared/lessons-core.ts; this handler re-parses the
 * same line grammar for display and never writes).
 */

// Same grammar as lessons-core.ts: `[YYYY-MM-DD][tag] text`
const LESSON_RE = /^\[(\d{4}-\d{2}-\d{2})\]\[([^\]]+)\]\s+(.*)$/;

function lessonsPath(): string {
	// LESSONS_FILE is the engine's documented override (docs/escape-hatches.md)
	const override = process.env.LESSONS_FILE;
	if (override && override.trim().length > 0) return override;
	return join(homedir(), ".pi", "agent", "lessons.md");
}

export function parseLessonLines(content: string, now = Date.now()): LessonRow[] {
	const rows: LessonRow[] = [];
	for (const raw of content.split("\n")) {
		const line = raw.trim();
		const m = LESSON_RE.exec(line);
		if (!m) continue; // malformed lines are invisible to the panel too
		const [, date, tag, text] = m;
		const ts = Date.parse(`${date}T00:00:00Z`);
		if (Number.isNaN(ts)) continue;
		rows.push({ date, tag, text, ageDays: Math.max(0, Math.floor((now - ts) / 86_400_000)) });
	}
	// newest first (same order the engine renders newest-last, inverted for UI)
	rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
	return rows;
}

export async function lessonsStateHandler(_input: RpcInput<typeof GetLessonsStateRpc>) {
	const file = lessonsPath();
	let present = false;
	let content = "";
	let mtime: string | null = null;
	try {
		present = existsSync(file);
		if (present) {
			content = readFileSync(file, "utf8");
			mtime = new Date(statSync(file).mtimeMs).toISOString();
		}
	} catch {
		present = false;
	}
	const lessons = present ? parseLessonLines(content) : [];
	return {
		present,
		file,
		total: lessons.length,
		mtime,
		generatedAt: new Date().toISOString(),
		lessons,
		note: present
			? null
			: "no lessons file yet — the engine creates ~/.pi/agent/lessons.md when the first lesson is folded",
	};
}
