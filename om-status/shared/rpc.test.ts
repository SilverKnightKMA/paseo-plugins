import { describe, expect, test } from "bun:test";
import { OmSummarySchema } from "./rpc.js";

/**
 * #100 (v1.0.75): the projection gained 8 summary fields (role split + storage/GC).
 * Old om-status.json files written by v1.4.119- engines lack them — the schema must
 * parse those with defaults instead of nulling the whole summary.
 */

const OLD_SUMMARY = {
	verdict: "healthy",
	observersRunning: 0,
	observerSlots: 2,
	consolidatorRunning: false,
	contextTokens: 60000,
	contextMax: 150000,
	poolTokens: 1000,
	poolMax: 60000,
	sessionCostUsd: 0.0123,
	sessionRuns: 7,
} as const;

describe("OmSummarySchema #100 additive fields", () => {
	test("old projection (pre-v1.4.120) parses with defaults", () => {
		const s = OmSummarySchema.parse(OLD_SUMMARY);
		expect(s.observerCostUsd).toBe(0);
		expect(s.observerRuns).toBe(0);
		expect(s.consolidatorCostUsd).toBe(0);
		expect(s.consolidatorRuns).toBe(0);
		expect(s.rollupFiles).toBe(0);
		expect(s.rollupCostUsd).toBe(0);
		expect(s.runsCostTtlDays).toBe(0);
		expect(s.lastRunsGcDay).toBe("");
		expect(s.sessionRuns).toBe(7); // untouched passthrough
	});

	test("new projection round-trips every field", () => {
		const s = OmSummarySchema.parse({
			...OLD_SUMMARY,
			observerCostUsd: 0.003,
			observerRuns: 5,
			consolidatorCostUsd: 0.0093,
			consolidatorRuns: 2,
			rollupFiles: 12,
			rollupCostUsd: 1.25,
			runsCostTtlDays: 7,
			lastRunsGcDay: "2026-09-18",
		});
		expect(s.observerCostUsd).toBe(0.003);
		expect(s.observerRuns).toBe(5);
		expect(s.consolidatorCostUsd).toBe(0.0093);
		expect(s.consolidatorRuns).toBe(2);
		expect(s.rollupFiles).toBe(12);
		expect(s.rollupCostUsd).toBe(1.25);
		expect(s.runsCostTtlDays).toBe(7);
		expect(s.lastRunsGcDay).toBe("2026-09-18");
	});

	test("unknown extra keys are stripped, not fatal", () => {
		const s = OmSummarySchema.parse({ ...OLD_SUMMARY, futureField: "x" });
		expect(s.sessionRuns).toBe(7);
	});
});
