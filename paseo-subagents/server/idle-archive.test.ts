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
	test("quét */*.json, bỏ JSON hỏng và record không id", () => {
		const root = mkdtempSync(join(tmpdir(), "idle-arch-"));
		mkdirSync(join(root, "ws-a"));
		mkdirSync(join(root, "ws-b"));
		writeFileSync(join(root, "ws-a", "a1.json"), JSON.stringify({ id: "a1", labels: { "subagent.parent": "P" }, lastStatus: "idle", lastActivityAt: "2026-09-20T17:00:00Z" }));
		writeFileSync(join(root, "ws-b", "b1.json"), "{NOT JSON");
		writeFileSync(join(root, "ws-b", "b2.json"), JSON.stringify({ title: "no-id" }));
		writeFileSync(join(root, "loose.json"), JSON.stringify({ id: "skip" })); // ngoài ws dir
		const out = readAgentRecords(root);
		expect(out.length).toBe(1);
		expect(out[0].id).toBe("a1");
	});
	test("root không tồn tại → [] (không throw)", () => {
		expect(readAgentRecords(join(tmpdir(), "khong-ton-ai-" + Date.now())).length).toBe(0);
	});
});

describe("toIdleChildren", () => {
	test("lọc theo subagent.parent, bỏ archived, map timestamps", () => {
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
	test(`${MIN_IDLE_CHILDREN} con idle 20m → nhắc kèm command`, () => {
		const r = shouldRemindIdleArchive(toIdleChildren(records(3), "P1"), NOW, 15);
		expect(r).not.toBeNull();
		expect(r!.command).toContain("paseo agent archive c0 c1 c2");
	});
	test("ít hơn MIN_IDLE_CHILDREN → im", () => {
		expect(shouldRemindIdleArchive(toIdleChildren(records(2), "P1"), NOW, 15)).toBeNull();
	});
	test("minutes=0 → tắt hẳn", () => {
		expect(shouldRemindIdleArchive(toIdleChildren(records(3), "P1"), NOW, 0)).toBeNull();
	});
	test("con running/waiting/attention/unknown-age → im", () => {
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
	test("con mới nhất còn trong grace window → im", () => {
		const rs = [...records(2), child("fresh", { lastActivityAt: new Date(NOW - 5 * 60_000).toISOString() })];
		expect(shouldRemindIdleArchive(toIdleChildren(rs, "P1"), NOW, 15)).toBeNull();
	});
});

describe("reminderArmed (re-arm)", () => {
	test("chưa từng nhắc → armed; trong cửa sổ → im; quá cửa sổ → armed lại", () => {
		expect(reminderArmed(undefined, NOW)).toBe(true);
		expect(reminderArmed(NOW - 10 * 60_000, NOW)).toBe(false);
		expect(reminderArmed(NOW - ARCHIVE_REMIND_REARM_MS - 1, NOW)).toBe(true);
	});
});

describe("attention terminal vs waiting (#141 E2E fix)", () => {
	test("reason finished/error → không chặn reminder (con one-shot bình thường)", () => {
		const rs = records(3, { attentionTimestamp: new Date(NOW - 30 * 60_000).toISOString(), attentionReason: "finished" });
		expect(shouldRemindIdleArchive(toIdleChildren(rs, "P1"), NOW, 15)).not.toBeNull();
		const rsErr = records(3, { attentionTimestamp: new Date(NOW - 30 * 60_000).toISOString(), attentionReason: "error" });
		expect(shouldRemindIdleArchive(toIdleChildren(rsErr, "P1"), NOW, 15)).not.toBeNull();
	});
	test("reason lạ/không terminal (vd 'question') → vẫn chặn (fail-closed)", () => {
		const rs = records(3, { attentionTimestamp: new Date(NOW - 30 * 60_000).toISOString(), attentionReason: "question" });
		expect(shouldRemindIdleArchive(toIdleChildren(rs, "P1"), NOW, 15)).toBeNull();
	});
});

describe("spawner filter (chống đôi lời với pi ext)", () => {
	test("con thiếu label subagent.spawner (con pi ext) → không được track", () => {
		const rs = records(3).map((r) => ({ ...r, labels: { ...r.labels, "subagent.spawner": "pi-ext" as string } }));
		expect(toIdleChildren(rs, "P1").length).toBe(0);
	});
});
