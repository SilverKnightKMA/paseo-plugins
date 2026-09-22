import { z } from "zod";

const RPC_NAME = /^[a-z][a-z0-9._-]*$/;

/**
 * Local copy of @getpaseo/plugin's defineRpc. Importing the server package
 * here drags require("@getpaseo/plugin") into the CLIENT bundle (panel imports
 * this file for schemas) and the app runtime rejects it: 'Module
 * "@getpaseo/plugin" is not available in plugin client code' — every memory
 * plugin timeline item rendered "Plugin timeline item unavailable" since
 * v1.0.0 (F9 2026-09-22, found by evaluating the daemon-served bundle in a
 * harness mirroring the app's module resolver).
 */
function defineRpc<T extends { name: string }>(definition: T) {
	const name = definition.name.trim();
	if (!RPC_NAME.test(name)) throw new Error(`Invalid plugin RPC method: ${definition.name}`);
	return { ...definition, name };
}

/**
 * Memory panel contract (#181, P4 of the memory part 2 plan 2026-09-21).
 * The engine (pi-config extensions/facts) owns the durable facts tier:
 * ~/.pi/agent/facts.md + the facts-status.json projection. This plugin only
 * READS the projection for humans and offers the USER-only un-tombstone
 * button (writes a control file the engine watches — pattern plan-control).
 */

export const CategoryCountSchema = z.object({
	category: z.string(),
	live: z.number(),
	tombstoned: z.number(),
});

export const FactRowSchema = z.object({
	id: z.string(),
	category: z.string(),
	date: z.string(),
	priority: z.string(),
	text: z.string(),
	ttl: z.string().nullish(),
	tombstoned: z.string().nullish(),
	reason: z.string().nullish(),
});

export const GetMemoryStateRpc = defineRpc({
	name: "memory.get-state",
	input: z.object({}),
	output: z.object({
		present: z.boolean(),
		file: z.string(),
		live: z.number(),
		tombstoned: z.number(),
		byCategory: z.array(CategoryCountSchema),
		lastCuration: z
			.object({
				ts: z.string(),
				outcome: z.string(),
				appliedVerdicts: z.number(),
				proposalsAdded: z.number(),
				trigger: z.string(),
			})
			.nullable(),
		curatorFailing: z.boolean(),
		failingStreak: z.number(),
		lastError: z.string().nullable(),
		nextThresholds: z.object({
			minLines: z.number(),
			minTokens: z.number(),
			minSessions: z.number(),
			floorDays: z.number(),
		}),
		mtime: z.string().nullable(),
		generatedAt: z.string(),
		/** Dead facts (newest tombstone first) — the un-tombstone list. */
		tombstones: z.array(FactRowSchema),
		note: z.string().nullish(),
	}),
});

export const MemoryUntombstoneRpc = defineRpc({
	name: "memory.untombstone",
	input: z.object({ id: z.string().min(1).max(8) }),
	output: z.object({
		ok: z.boolean(),
		queued: z.boolean(),
		detail: z.string(),
	}),
});

export type CategoryCount = z.infer<typeof CategoryCountSchema>;
export type FactRow = z.infer<typeof FactRowSchema>;
export type MemoryState = z.infer<typeof GetMemoryStateRpc.output>;
