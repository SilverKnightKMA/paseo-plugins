import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";

/**
 * Lessons panel contract (#110). The engine (pi-config extensions/lessons)
 * injects the parsed block into model context at session_start and after
 * compaction — the plugin only READS the same source file for humans:
 * ~/.pi/agent/lessons.md, one lesson per line as `[YYYY-MM-DD][tag] text`.
 */
export const LessonRowSchema = z.object({
	date: z.string(),
	tag: z.string(),
	text: z.string(),
	ageDays: z.number(),
});

export const GetLessonsStateRpc = defineRpc({
	name: "lessons.get-state",
	input: z.object({}),
	output: z.object({
		present: z.boolean(),
		file: z.string(),
		total: z.number(),
		mtime: z.string().nullable(),
		generatedAt: z.string(),
		/** newest first */
		lessons: z.array(LessonRowSchema),
		note: z.string().nullish(),
	}),
});

export type LessonRow = z.infer<typeof LessonRowSchema>;
export type LessonsState = z.infer<typeof GetLessonsStateRpc.output>;
