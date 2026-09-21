/** memory plugin server tests — P4 (#181). bun:test, sandboxed $HOME. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryStateHandler, parseFactLines, untombstoneHandler } from "./memory-state.js";

let tmp: string;
let savedHome: string | undefined;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "memory-plugin-"));
	savedHome = process.env.HOME;
	process.env.HOME = tmp;
	delete process.env.FACTS_FILE;
});

afterEach(() => {
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	rmSync(tmp, { recursive: true, force: true });
});

const STORE = [
	"[convention][2026-09-01][P1] test runner: bun (#aaa001)",
	"[convention][2026-09-05][P2] plain language first (#aaa002) tombstoned=2026-09-20 reason=curator:superseded",
	"[ops][2026-09-03][P3] port 34091 (#aaa003) ttl=2026-12-31",
	"garbage line",
].join("\n");

describe("parseFactLines", () => {
	test("live / tombstoned / ttl shapes + garbage dropped", () => {
		const rows = parseFactLines(STORE);
		expect(rows).toHaveLength(3);
		expect(rows[0]).toMatchObject({ id: "aaa001", category: "convention", priority: "P1", tombstoned: null });
		expect(rows[1]).toMatchObject({ id: "aaa002", tombstoned: "2026-09-20", reason: "curator:superseded" });
		expect(rows[2]).toMatchObject({ id: "aaa003", ttl: "2026-12-31" });
	});
});

describe("memoryStateHandler", () => {
	test("no store → present:false + note; fallback defaults", async () => {
		const s = await memoryStateHandler({});
		expect(s.present).toBe(false);
		expect(s.live).toBe(0);
		expect(s.note).toContain("no facts store yet");
	});

	test("store present → counts + tombstone list newest-first; projection preferred when newer", async () => {
		mkdirSync(join(tmp, ".pi", "agent"), { recursive: true });
		writeFileSync(join(tmp, ".pi", "agent", "facts.md"), STORE);
		const s = await memoryStateHandler({});
		expect(s.present).toBe(true);
		expect(s.live).toBe(2);
		expect(s.tombstoned).toBe(1);
		expect(s.tombstones).toHaveLength(1);
		expect(s.tombstones[0].id).toBe("aaa002");
		// engine projection wins when present
		writeFileSync(
			join(tmp, ".pi", "agent", "facts-status.json"),
			JSON.stringify({ live: 99, tombstoned: 0, byCategory: [], curatorFailing: true, failingStreak: 3, lastError: "planner failed" }),
		);
		const s2 = await memoryStateHandler({});
		expect(s2.live).toBe(99);
		expect(s2.curatorFailing).toBe(true);
		expect(s2.failingStreak).toBe(3);
	});
});

describe("untombstoneHandler (user-only control file)", () => {
	test("valid id writes a pending control file the engine will ack", async () => {
		const r = await untombstoneHandler({ id: "aaa002" });
		expect(r).toMatchObject({ ok: true, queued: true });
		const dir = join(tmp, ".pi", "agent", "facts-control");
		const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
		expect(files).toHaveLength(1);
		const ctl = JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
		expect(ctl).toMatchObject({ action: "untombstone", id: "aaa002" });
		expect(ctl.ts).toBeTruthy();
		expect("status" in ctl).toBe(false); // no ack yet — engine applies async
	});

	test("bad id rejected without writing anything", async () => {
		const r = await untombstoneHandler({ id: "zzz" });
		expect(r.ok).toBe(false);
		expect(r.queued).toBe(false);
		expect(() => readdirSync(join(tmp, ".pi", "agent", "facts-control"))).toThrow();
	});
});
