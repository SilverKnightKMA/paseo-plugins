import { describe, expect, test } from "bun:test";
import {
	readAgentRecords,
	selectAutoArchivable,
	selectRemindable,
	formatHousekeeping,
	DEFAULT_REMIND_AFTER_MINUTES,
	DEFAULT_ARCHIVE_AFTER_DAYS,
	MAX_ARCHIVE_AFTER_DAYS,
	type AgentRecordLite,
} from "./idle-archive.ts";
import { remindedPath, loadReminded, saveReminded, REMINDED_TTL_MS } from "./reminded-store.ts";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
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

describe("selectAutoArchivable (#224/#230 tier 2 — per-child, fail-closed)", () => {
	test("a terminal plugin child past the force window is selected with identity", () => {
		const out = selectAutoArchivable([child("c1")], NOW, 15);
		expect(out.length).toBe(1);
		expect(out[0]).toMatchObject({ id: "c1", parentId: "P1", idleMinutes: 20 });
	});

	test("still inside the window → not selected; boundary exactly at the window IS selected", () => {
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

	test(`two-tier defaults: remind ${DEFAULT_REMIND_AFTER_MINUTES}m, force ${DEFAULT_ARCHIVE_AFTER_DAYS}d (cap ${MAX_ARCHIVE_AFTER_DAYS}d)`, () => {
		expect(DEFAULT_REMIND_AFTER_MINUTES).toBe(30);
		expect(DEFAULT_ARCHIVE_AFTER_DAYS).toBe(7);
		expect(MAX_ARCHIVE_AFTER_DAYS).toBe(90);
	});
});

describe("selectRemindable (#230 tier 1 — once per child, tool guidance)", () => {
	test("a settled child past the remind window is selected with role for the message", () => {
		const out = selectRemindable([child("c1", { lastActivityAt: new Date(NOW - 45 * 60_000).toISOString() })], NOW, 30, new Set());
		expect(out.length).toBe(1);
		expect(out[0]).toMatchObject({ id: "c1", parentId: "P1", role: "scout", idleMinutes: 45 });
	});

	test("ALREADY-REMINDED children are never selected again (once-per-child, #141 nag fix)", () => {
		expect(selectRemindable([child("c1")], NOW, 15, new Set(["c1"]))).toEqual([]);
	});

	test("reminder window: inside → skip, boundary → selected; minutes=0 → off", () => {
		expect(selectRemindable([child("fresh", { lastActivityAt: new Date(NOW - 29 * 60_000).toISOString() })], NOW, 30, new Set())).toEqual([]);
		expect(selectRemindable([child("edge", { lastActivityAt: new Date(NOW - 30 * 60_000).toISOString() })], NOW, 30, new Set()).length).toBe(1);
		expect(selectRemindable([child("c1")], NOW, 0, new Set())).toEqual([]);
	});

	test("tier 1 uses the SAME fail-closed gates: running / question-attention / archived / foreign children all skip", () => {
		expect(selectRemindable([child("run", { lastStatus: "running" })], NOW, 15, new Set())).toEqual([]);
		expect(
			selectRemindable([child("asked", { attentionTimestamp: new Date(NOW - 18 * 60_000).toISOString(), attentionReason: "question" })], NOW, 15, new Set()),
		).toEqual([]);
		expect(selectRemindable([child("gone", { archivedAt: new Date(NOW).toISOString() })], NOW, 15, new Set())).toEqual([]);
		expect(selectRemindable([child("piext", { labels: { "subagent.parent": "P1" } })], NOW, 15, new Set())).toEqual([]);
	});

	test("an unreminded sibling of a reminded child is still selected (per-child, not per-parent)", () => {
		const out = selectRemindable([child("r1"), child("r2")], NOW, 15, new Set(["r1"]));
		expect(out.map((c) => c.id)).toEqual(["r2"]);
	});

	test("formatHousekeeping: self-describing, mentions the TOOLS and the force window — never a CLI command", () => {
		const text = formatHousekeeping(
			[{ id: "11111111-2222-3333-4444-555555555555", title: "scout A", role: "scout", parentId: "P1", idleMinutes: 42 }],
			30,
			7,
		);
		expect(text.startsWith("[housekeeping] 1 of your subagents have been settled and idle for ≥30 minutes:")).toBe(true);
		expect(text).toContain("11111111 · scout · scout A · idle 42m");
		expect(text).toContain("archive_subagent");
		expect(text).toContain("list_subagents");
		expect(text).toContain("archived automatically after 7 day(s)");
		expect(text).not.toContain("paseo agent archive");
		expect(text).not.toContain("CLI");
	});
});

describe("reminded-store (#230 — persistence across restarts)", () => {
	test("roundtrip: save then load returns the same entries", () => {
		const dir = mkdtempSync(join(tmpdir(), "reminded-"));
		const p = remindedPath(dir);
		const m = new Map([["c1", NOW], ["c2", NOW - 1000]]);
		saveReminded(p, m, NOW);
		expect(existsSync(p)).toBe(true);
		const back = loadReminded(p);
		expect(back.get("c1")).toBe(NOW);
		expect(back.get("c2")).toBe(NOW - 1000);
	});

	test("entries older than the TTL are pruned on save", () => {
		const dir = mkdtempSync(join(tmpdir(), "reminded-"));
		const p = remindedPath(dir);
		const stale = NOW - REMINDED_TTL_MS - 1;
		const pruned = saveReminded(p, new Map([["old", stale], ["new", NOW]]), NOW);
		expect(pruned.has("old")).toBe(false);
		expect(pruned.has("new")).toBe(true);
		expect(JSON.parse(readFileSync(p, "utf-8")).old).toBeUndefined();
	});

	test("a corrupt file loads as empty — worst case is one extra reminder, never a crash", () => {
		const dir = mkdtempSync(join(tmpdir(), "reminded-"));
		const p = remindedPath(dir);
		writeFileSync(p, "{NOT JSON");
		expect(loadReminded(p).size).toBe(0);
	});
});
