import { describe, expect, test } from "bun:test";
import {
	readAgentRecords,
	selectAutoArchivable,
	DEFAULT_REMIND_MINUTES,
	type AgentRecordLite,
} from "./idle-archive.ts";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = Date.parse("2026-09-22T10:00:00.000Z");
const child = (id: string, over: Partial<AgentRecordLite> = {}): AgentRecordLite => ({
	id,
	title: id,
	labels: { "subagent.parent": "P1", "subagent.role": "scout", "subagent.spawner": "paseo-subagents" },
	lastStatus: "idle",
	lastActivityAt: new Date(NOW - 20 * 60_000).toISOString(),
	attentionTimestamp: null,
	attentionReason: null,
	archivedAt: null,
	...over,
});

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

describe("selectAutoArchivable (#224 — per-child, fail-closed)", () => {
	test("a terminal plugin child past the grace window is selected with identity", () => {
		const out = selectAutoArchivable([child("c1")], NOW, 15);
		expect(out.length).toBe(1);
		expect(out[0]).toMatchObject({ id: "c1", parentId: "P1", idleMinutes: 20 });
	});

	test("still inside the grace window → not selected; boundary exactly at the window IS selected", () => {
		expect(selectAutoArchivable([child("fresh", { lastActivityAt: new Date(NOW - 5 * 60_000).toISOString() })], NOW, 15)).toEqual([]);
		expect(selectAutoArchivable([child("edge", { lastActivityAt: new Date(NOW - 15 * 60_000).toISOString() })], NOW, 15).length).toBe(1);
	});

	test("minutes=0 → disabled (escape hatch)", () => {
		expect(selectAutoArchivable([child("c1")], NOW, 0)).toEqual([]);
	});

	test("non-terminal statuses are never selected (running / initializing / waiting / missing)", () => {
		for (const status of ["running", "initializing", "waiting", null]) {
			expect(selectAutoArchivable([child("busy", { lastStatus: status })], NOW, 15)).toEqual([]);
		}
	});

	test("error and closed terminal children ARE selected (settled one-shots)", () => {
		expect(selectAutoArchivable([child("err", { lastStatus: "error" })], NOW, 15).length).toBe(1);
		expect(selectAutoArchivable([child("closed", { lastStatus: "closed" })], NOW, 15).length).toBe(1);
	});

	test("attention terminal vs waiting (#141 E2E fix preserved)", () => {
		// 'finished' is the daemon's stamp on EVERY completed one-shot child — archiveable.
		expect(
			selectAutoArchivable([child("done", { attentionTimestamp: new Date(NOW - 18 * 60_000).toISOString(), attentionReason: "finished" })], NOW, 15).length,
		).toBe(1);
		expect(
			selectAutoArchivable([child("err-att", { attentionTimestamp: new Date(NOW - 18 * 60_000).toISOString(), attentionReason: "error" })], NOW, 15).length,
		).toBe(1);
		// An unknown/non-terminal reason (e.g. a parked question) still blocks (fail-closed).
		expect(
			selectAutoArchivable([child("asked", { attentionTimestamp: new Date(NOW - 18 * 60_000).toISOString(), attentionReason: "question" })], NOW, 15),
		).toEqual([]);
	});

	test("already-archived, unknown-age, and non-plugin children are skipped", () => {
		expect(selectAutoArchivable([child("gone", { archivedAt: new Date(NOW).toISOString() })], NOW, 15)).toEqual([]);
		expect(selectAutoArchivable([child("mystery", { lastActivityAt: undefined })], NOW, 15)).toEqual([]);
		expect(
			selectAutoArchivable([child("piext", { labels: { "subagent.parent": "P1" } })], NOW, 15),
		).toEqual([]); // pi-ext child: no subagent.spawner label — not ours to archive.
	});

	test("children of DIFFERENT parents are selected independently — one stuck parent cannot hold the set", () => {
		const out = selectAutoArchivable(
			[
				child("a", { labels: { "subagent.parent": "codex-parent", "subagent.spawner": "paseo-subagents" } }),
				child("b", { labels: { "subagent.parent": "claude-parent", "subagent.spawner": "paseo-subagents" } }),
			],
			NOW,
			15,
		);
		expect(out.length).toBe(2);
		expect(new Set(out.map((c) => c.parentId)).size).toBe(2);
	});

	test(`default grace window is ${DEFAULT_REMIND_MINUTES} minutes`, () => {
		expect(DEFAULT_REMIND_MINUTES).toBe(15);
	});
});
