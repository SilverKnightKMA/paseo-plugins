import { describe, expect, test } from "bun:test";
import {
	readAgentRecords,
	toIdleChildren,
	shouldRemindIdleArchive,
	reminderArmed,
	ARCHIVE_REMIND_REARM_MS,
	MIN_IDLE_CHILDREN,
} from "./idle-archive.ts";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = Date.parse("2026-09-20T18:00:00.000Z");
const child = (id: string, over: Partial<Parameters<typeof toIdleChildren>[0][number]> = {}) => ({
	id,
	title: id,
	labels: { "subagent.parent": "P1", "subagent.role": "scout", "subagent.spawner": "paseo-subagents" },
	lastStatus: "idle",
	lastActivityAt: new Date(NOW - 20 * 60_000).toISOString(),
	attentionTimestamp: null,
	archivedAt: null,
	...over,
});
const records = (n: number, over: Partial<Parameters<typeof child>[1]> = {}) =>
	Array.from({ length: n }, (_, i) => child(`c${i}`, over));

describe("readAgentRecords (fixture dir)", () => {
	test("scans */*.json and skips invalid JSON and records without IDs", () => {
		const root = mkdtempSync(join(tmpdir(), "idle-arch-"));
		mkdirSync(join(root, "ws-a"));
		mkdirSync(join(root, "ws-b"));
		writeFileSync(join(root, "ws-a", "a1.json"), JSON.stringify({ id: "a1", labels: { "subagent.parent": "P" }, lastStatus: "idle", lastActivityAt: "2026-09-20T17:00:00Z" }));
		writeFileSync(join(root, "ws-b", "b1.json"), "{NOT JSON");
		writeFileSync(join(root, "ws-b", "b2.json"), JSON.stringify({ title: "no-id" }));
		writeFileSync(join(root, "loose.json"), JSON.stringify({ id: "skip" })); // Outside the workspace directory.
		const out = readAgentRecords(root);
		expect(out.length).toBe(1);
		expect(out[0].id).toBe("a1");
	});
	test("a missing root returns [] without throwing", () => {
		expect(readAgentRecords(join(tmpdir(), "khong-ton-ai-" + Date.now())).length).toBe(0);
	});
});

describe("toIdleChildren", () => {
	test("filters by subagent.parent, excludes archived records, and maps timestamps", () => {
		const rs = [
			...records(2),
			child("gone", { archivedAt: new Date(NOW).toISOString() }),
			{ ...child("other"), labels: { "subagent.parent": "P2" } },
		];
		const cs = toIdleChildren(rs, "P1");
		expect(cs.length).toBe(2);
		expect(cs[0].lastActivityMs).toBe(NOW - 20 * 60_000);
	});
});

describe("shouldRemindIdleArchive (port #129, fail-closed)", () => {
	test(`${MIN_IDLE_CHILDREN} children idle for 20m → reminder with command`, () => {
		const r = shouldRemindIdleArchive(toIdleChildren(records(3), "P1"), NOW, 15);
		expect(r).not.toBeNull();
		expect(r!.command).toContain("paseo agent archive c0 c1 c2");
	});
	test("fewer than MIN_IDLE_CHILDREN → no reminder", () => {
		expect(shouldRemindIdleArchive(toIdleChildren(records(2), "P1"), NOW, 15)).toBeNull();
	});
	test("minutes=0 → completely disabled", () => {
		expect(shouldRemindIdleArchive(toIdleChildren(records(3), "P1"), NOW, 0)).toBeNull();
	});
	test("a running/waiting/attention/unknown-age child → no reminder", () => {
		for (const over of [
			{ lastStatus: "running" },
			{ lastStatus: "waiting" },
			{ attentionTimestamp: new Date(NOW - 60_000).toISOString() },
			{ lastActivityAt: undefined as unknown as string },
		]) {
			const rs = records(3, over);
			expect(shouldRemindIdleArchive(toIdleChildren(rs, "P1"), NOW, 15)).toBeNull();
		}
	});
	test("the newest child is still in the grace window → no reminder", () => {
		const rs = [...records(2), child("fresh", { lastActivityAt: new Date(NOW - 5 * 60_000).toISOString() })];
		expect(shouldRemindIdleArchive(toIdleChildren(rs, "P1"), NOW, 15)).toBeNull();
	});
});

describe("reminderArmed (re-arm)", () => {
	test("never reminded → armed; within the window → quiet; after the window → armed again", () => {
		expect(reminderArmed(undefined, NOW)).toBe(true);
		expect(reminderArmed(NOW - 10 * 60_000, NOW)).toBe(false);
		expect(reminderArmed(NOW - ARCHIVE_REMIND_REARM_MS - 1, NOW)).toBe(true);
	});
});

describe("attention terminal vs waiting (#141 E2E fix)", () => {
	test("finished/error reasons do not block reminders (normal one-shot child)", () => {
		const rs = records(3, { attentionTimestamp: new Date(NOW - 30 * 60_000).toISOString(), attentionReason: "finished" });
		expect(shouldRemindIdleArchive(toIdleChildren(rs, "P1"), NOW, 15)).not.toBeNull();
		const rsErr = records(3, { attentionTimestamp: new Date(NOW - 30 * 60_000).toISOString(), attentionReason: "error" });
		expect(shouldRemindIdleArchive(toIdleChildren(rsErr, "P1"), NOW, 15)).not.toBeNull();
	});
	test("an unknown/non-terminal reason (for example 'question') still blocks (fail-closed)", () => {
		const rs = records(3, { attentionTimestamp: new Date(NOW - 30 * 60_000).toISOString(), attentionReason: "question" });
		expect(shouldRemindIdleArchive(toIdleChildren(rs, "P1"), NOW, 15)).toBeNull();
	});
});

describe("spawner filter (prevents duplicate reminders with pi ext)", () => {
	test("a child without the subagent.spawner label (a pi ext child) is not tracked", () => {
		const rs = records(3).map((r) => ({ ...r, labels: { ...r.labels, "subagent.spawner": "pi-ext" as string } }));
		expect(toIdleChildren(rs, "P1").length).toBe(0);
	});
});
