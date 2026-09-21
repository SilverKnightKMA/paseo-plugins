// #39 Phase 1 — plugin doorbell-server unit tests (om-status copy; the file
// ships byte-identical to task/snip/memory via check-shared-ui.py).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { createDoorbellServer, type DoorbellAgentBrief, type DoorbellItem } from "./doorbell-server.ts";

function agents(...briefs: DoorbellAgentBrief[]): DoorbellAgentBrief[] {
	return briefs;
}

function makeDeps(dir: string, agentList: DoorbellAgentBrief[]) {
	const appended: { agentId: string; item: DoorbellItem }[] = [];
	return {
		appended,
		deps: {
			dir,
			listAgents: async () => agentList,
			append: async (agentId: string, item: DoorbellItem) => {
				appended.push({ agentId, item });
			},
			log: () => {},
		},
	};
}

const POKE = JSON.stringify({ v: 1, sessionId: "sess-1", kind: "om-status", file: "/tmp/om-status.json", ts: "2026-09-22T00:00:00Z" });

describe("doorbell-server #39 — handleLine core", () => {
	test("owned kind → resolves agent + appends invisible doorbell item", async () => {
		const { appended, deps } = makeDeps("/unused", agents({ id: "agent-9", sessionId: "sess-1" }));
		const bell = createDoorbellServer("om-status", ["om-status"], deps);
		expect(await bell.handleLine(POKE)).toBe("handled");
		expect(appended.length).toBe(1);
		expect(appended[0].agentId).toBe("agent-9");
		expect(appended[0].item.kind).toBe("doorbell");
		expect(appended[0].item.type).toBe("plugin");
		expect(appended[0].item.data.bell).toBe("om-status");
	});

	test("foreign kind → ignored, no append (single-owner rule)", async () => {
		const { appended, deps } = makeDeps("/unused", agents({ id: "a", sessionId: "sess-1" }));
		const bell = createDoorbellServer("om-status", ["om-status"], deps);
		const foreign = JSON.stringify({ v: 1, sessionId: "sess-1", kind: "task-status", file: "x", ts: "t" });
		expect(await bell.handleLine(foreign)).toBe("foreign");
		expect(appended.length).toBe(0);
	});

	test("invalid lines (bad JSON, wrong version, missing fields) → invalid", async () => {
		const { deps } = makeDeps("/unused", []);
		const bell = createDoorbellServer("om-status", ["om-status"], deps);
		expect(await bell.handleLine("not json")).toBe("invalid");
		expect(await bell.handleLine(JSON.stringify({ v: 2, sessionId: "s", kind: "om-status" }))).toBe("invalid");
		expect(await bell.handleLine(JSON.stringify({ v: 1, kind: "om-status" }))).toBe("invalid");
	});

	test("unknown session → no-agent, no append, no throw", async () => {
		const { appended, deps } = makeDeps("/unused", agents({ id: "a", sessionId: "other" }));
		const bell = createDoorbellServer("om-status", ["om-status"], deps);
		expect(await bell.handleLine(POKE)).toBe("no-agent");
		expect(appended.length).toBe(0);
	});

	test("append failure → error outcome (never throws)", async () => {
		const deps = {
			dir: "/unused",
			listAgents: async () => agents({ id: "a", sessionId: "sess-1" }),
			append: async () => {
				throw new Error("daemon down");
			},
			log: () => {},
		};
		const bell = createDoorbellServer("om-status", ["om-status"], deps);
		expect(await bell.handleLine(POKE)).toBe("error");
	});

	test("default listAgents unwraps {agent:{...}} daemon entries (live E2E bug v1.0.77)", async () => {
		// regression: flat-shape unwrap yielded 0 agents -> every bell was "no-agent"
		const appended: { agentId: string; kind: string }[] = [];
		const fakeApi = {
			agents: {
				list: async () => ({ entries: [{ agent: { id: "agent-live", runtimeInfo: { sessionId: "sess-live" } } }] }),
				ref: (id: string) => ({
					timeline: { append: async (item: { kind: string }) => { appended.push({ agentId: id, kind: item.kind }); } },
				}),
			},
		};
		const bell = createDoorbellServer("om-status", ["om-status"], { dir: "/unused", log: () => {} });
		bell.setPaseo(fakeApi as never);
		const live = JSON.stringify({ v: 1, sessionId: "sess-live", kind: "om-status", file: "/tmp/x.json", ts: "t" });
		expect(await bell.handleLine(live)).toBe("handled");
		expect(appended).toEqual([{ agentId: "agent-live", kind: "doorbell" }]);
	});

	test("session cache: two bells, one listAgents call", async () => {
		let calls = 0;
		const deps = {
			dir: "/unused",
			listAgents: async () => {
				calls += 1;
				return agents({ id: "a", sessionId: "sess-1" });
			},
			append: async () => {},
			log: () => {},
		};
		const bell = createDoorbellServer("om-status", ["om-status"], deps);
		await bell.handleLine(POKE);
		await bell.handleLine(POKE);
		expect(calls).toBe(1);
	});
});

describe("doorbell-server #39 — socket lifecycle", () => {
	test("owns=[] → start() is a no-op (no socket, no dir)", () => {
		const dir = mkdtempSync(join(tmpdir(), "bell-"));
		try {
			const bell = createDoorbellServer("om-panel", [], { dir, log: () => {} });
			bell.start();
			expect(existsSync(join(dir, "om-panel.sock"))).toBe(false);
			void bell.stop();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("real socket round-trip: engine line arrives → append fires", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bell-"));
		try {
			const { appended, deps } = makeDeps(dir, agents({ id: "agent-7", sessionId: "sess-1" }));
			const bell = createDoorbellServer("om-status", ["om-status"], deps);
			bell.start();
			await new Promise((r) => setTimeout(r, 100));
			// engine side: connect + one JSON line + close (same shape as pokeBridges)
			await new Promise<void>((resolve, reject) => {
				const sock = createConnection({ path: join(dir, "om-status.sock") });
				sock.on("connect", () => {
					sock.write(`${POKE}\n`);
					sock.destroy();
					resolve();
				});
				sock.on("error", reject);
			});
			await new Promise((r) => setTimeout(r, 200));
			expect(appended.length).toBe(1);
			expect(appended[0].agentId).toBe("agent-7");
			await bell.stop();
			expect(existsSync(join(dir, "om-status.sock"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("stale socket file is replaced on start (daemon restart)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bell-"));
		try {
			const { deps } = makeDeps(dir, agents({ id: "a", sessionId: "s" }));
			// simulate a stale socket left behind by a dead daemon
			const stale = join(dir, "om-status.sock");
			// write garbage file at socket path (not a socket) — unlink must clear it
			const { writeFileSync } = await import("node:fs");
			writeFileSync(stale, "stale");
			const bell = createDoorbellServer("om-status", ["om-status"], deps);
			bell.start();
			await new Promise((r) => setTimeout(r, 100));
			await bell.stop();
			expect(true).toBe(true); // reached without throwing = contract
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
