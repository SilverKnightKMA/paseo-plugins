import { z } from "zod";

/** v1 chip data for the injected lessons block replacement (#110). */
export const LessonsChipSchema = z.object({
	/** lessons listed in the injected block */
	count: z.number().int().min(0),
	/** engine inject window (LESSONS_MAX_AGE_DAYS, default 30) */
	maxAgeDays: z.number().int().min(1),
});

export type LessonsChipData = z.infer<typeof LessonsChipSchema>;
