import { describe, expect, test } from "bun:test";
import {
	isTerminal,
	lastAssistantText,
	autoReportEnvelope,
	truncateText,
	AUTO_REPORT_MAX_CHARS,
	type WatchedChild,
} from "./auto-report";

const child: WatchedChild = {
	agentId: "a15788c7-a137-4bed-b8fb-9a9e83320151",
	parentId: "cf76ad71-3f82-4296-960f-fa9e2fcd06ee",
	title: "f10-smoke-scout",
	role: "scout",
	providerModel: "pi/cli-openai/mmcp/MiniMax-M3",
	spawnedAt: Date.now(),
};

describe("isTerminal (#225)", () => {
	test("idle / error / closed / archived are terminal", () => {
		expect(isTerminal({ lastStatus: "idle" })).toBe(true);
		expect(isTerminal({ lastStatus: "error" })).toBe(true);
		expect(isTerminal({ lastStatus: "closed" })).toBe(true);
		expect(isTerminal({ lastStatus: "running", archivedAt: "2026-09-22T09:00:00Z" })).toBe(true);
	});

	test("running / initializing / null are NOT terminal", () => {
		expect(isTerminal({ lastStatus: "running" })).toBe(false);
		expect(isTerminal({ lastStatus: "initializing" })).toBe(false);
		expect(isTerminal({})).toBe(false);
	});
});

describe("lastAssistantText (#225)", () => {
	test("returns the LAST assistant_message", () => {
		const items = [
			{ type: "user_message", text: "task" },
			{ type: "assistant_message", text: "working…" },
			{ type: "assistant_message", text: "F10-SCOUT-OK" },
			{ type: "tool_call", name: "read" },
		];
		expect(lastAssistantText(items)).toBe("F10-SCOUT-OK");
	});

	test("no assistant messages => null", () => {
		expect(lastAssistantText([{ type: "user_message", text: "x" }])).toBeNull();
		expect(lastAssistantText([])).toBeNull();
	});
});

describe("autoReportEnvelope (#226 identity header)", () => {
	test("carries role, agentId-8, providerModel and the auto marker", () => {
		const env = autoReportEnvelope(child, "F10-SCOUT-OK");
		expect(env.startsWith("[child-report] f10-smoke-scout (scout, a15788c7, pi/cli-openai/mmcp/MiniMax-M3): F10-SCOUT-OK")).toBe(true);
		expect(env).toContain("[auto-report]");
	});

	test("omits unknown identity parts; honest when no text found", () => {
		const bare: WatchedChild = {
			agentId: "11111111-2222-3333-4444-555555555555",
			parentId: "p",
			title: "orphan",
			spawnedAt: Date.now(),
		};
		const env = autoReportEnvelope(bare, null);
		expect(env).toContain("[child-report] orphan (11111111): (no assistant text found");
	});

	test("truncates runaway text", () => {
		const long = "x".repeat(AUTO_REPORT_MAX_CHARS + 5000);
		const env = autoReportEnvelope(child, long);
		expect(env.length).toBeLessThan(AUTO_REPORT_MAX_CHARS + 500);
		expect(env).toContain("…(truncated");
		expect(truncateText("short")).toBe("short");
	});
});
