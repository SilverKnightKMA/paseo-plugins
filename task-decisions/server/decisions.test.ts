import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeEntries, pokeControl } from "./decisions.js";
import { buttonsForKind } from "../client/buttons.js";

describe("#258 task-decisions — artifact parsing + button mapping + poke payloads", () => {
	test("sanitizeEntries parses all four kinds and drops junk", () => {
		const raw = [
			{ id: "d-1", taskId: 174, kind: "amend", reason: "brief drifted", createdAt: "2026-09-23T01:00:00Z", decidedAt: null, decision: null },
			{ id: "d-2", taskId: 175, kind: "cancel-proposal", reason: "superseded", createdAt: "2026-09-23T02:00:00Z", decidedAt: null, decision: null },
			{ id: "d-3", taskId: 176, kind: "appeal", reason: "judge wrong", createdAt: "2026-09-23T03:00:00Z", decidedAt: null, decision: null },
			{ id: "d-4", taskId: 177, kind: "note", reason: "cho nhóm 1a", createdAt: "2026-09-23T04:00:00Z", decidedAt: null, decision: null },
			{ id: "junk", taskId: 1, kind: "amend" },
			{ id: "d-5", taskId: "x", kind: "amend" },
			"not-an-object",
		];
		const entries = sanitizeEntries(raw);
		expect(entries.length).toBe(4);
		expect(entries.map((e) => e.kind)).toEqual(["amend", "cancel-proposal", "appeal", "note"]);
	});

	test("buttonsForKind: amend/appeal → APPROVE/REJECT; cancel-proposal → CANCEL TASK/KEEP; note → none", () => {
		expect(buttonsForKind("amend")).toEqual(["APPROVE", "REJECT"]);
		expect(buttonsForKind("appeal")).toEqual(["APPROVE", "REJECT"]);
		expect(buttonsForKind("cancel-proposal")).toEqual(["CANCEL TASK", "KEEP"]);
		expect(buttonsForKind("note")).toEqual([]);
	});

	test("pokeControl writes the exact control.ts shapes (task dId-decide, cancel, plan-on)", async () => {
		const home = mkdtempSync(join(tmpdir(), "task-dec-"));
		const prevHome = process.env.HOME;
		process.env.HOME = home;
		try {
			mkdirSync(join(home, ".pi", "agent"), { recursive: true });
			// (a) dId decision — the engine's v1.4.135 proposal-decide shape
			let r = await pokeControl({ sessionId: "sess-1", action: "proposal-decide", taskId: 174, dId: "d-2", decision: "approved" });
			expect(r.ok).toBe(true);
			const taskFile = join(home, ".pi", "agent", "task-control", "sess-1.json");
			expect(existsSync(taskFile)).toBe(true);
			const payload = JSON.parse(readFileSync(taskFile, "utf8")) as Record<string, unknown>;
			expect(payload.v).toBe(1);
			expect(payload.action).toBe("proposal-decide");
			expect(payload.id).toBe(174);
			expect(payload.dId).toBe("d-2");
			expect(payload.decision).toBe("approved");
			expect(typeof payload.sentAt).toBe("string");
			// (b) user cancel — the old verb the CANCEL TASK button uses
			r = await pokeControl({ sessionId: "sess-1", action: "cancel", taskId: 174 });
			expect(r.ok).toBe(true);
			const cancelPayload = JSON.parse(readFileSync(taskFile, "utf8")) as Record<string, unknown>;
			expect(cancelPayload.action).toBe("cancel");
			expect(cancelPayload.dId).toBeUndefined();
			// (c) plan-mode poke — read-only-mode plan-control shape
			r = await pokeControl({ sessionId: "sess-1", action: "plan-on" });
			expect(r.ok).toBe(true);
			const planFile = join(home, ".pi", "agent", "plan-control", "sess-1.json");
			const planPayload = JSON.parse(readFileSync(planFile, "utf8")) as Record<string, unknown>;
			expect(planPayload).toEqual({ v: 1, action: "on", sentAt: planPayload.sentAt });
			expect(typeof planPayload.sentAt).toBe("string");
		} finally {
			if (prevHome !== undefined) process.env.HOME = prevHome;
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("readDecisions: artifact + projection merge, undecided filter (tmp HOME)", async () => {
		const home = mkdtempSync(join(tmpdir(), "task-dec-"));
		const prevHome = process.env.HOME;
		process.env.HOME = home;
		const { readDecisions } = await import("./decisions.js");
		try {
			const dir = join(home, ".pi", "agent", "task-status");
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "sess-a.decisions.json"),
				JSON.stringify([
					{ id: "d-1", taskId: 1, kind: "amend", reason: "r1", createdAt: "2026-09-23T01:00:00Z", decidedAt: null, decision: null },
					{ id: "d-2", taskId: 2, kind: "note", reason: "n2", createdAt: "2026-09-23T02:00:00Z", decidedAt: "2026-09-23T03:00:00Z", decision: "approved" },
				]),
			);
			writeFileSync(join(dir, "sess-a.json"), JSON.stringify({ tasks: [{ id: 1, subject: "alpha", status: "held" }, { id: 2, subject: "beta", status: "pending" }] }));
			const context = {
				paseo: {
					agents: {
						list: async () => ({ entries: [{ agent: { id: "a1", workspaceId: "ws-1", title: "main chat", runtimeInfo: { sessionId: "sess-a" } } }] }),
					},
				},
			};
			const out = await readDecisions({ workspaceId: "ws-1", includeDecided: false }, context as never);
			expect(out.sessions.length).toBe(1);
			const s = out.sessions[0]!;
			expect(s.entries.length).toBe(1); // decided d-2 filtered out by default
			expect(s.entries[0]!.id).toBe("d-1");
			expect(s.tasks.length).toBe(1); // only referenced tasks ride along
			expect(s.tasks[0]!.subject).toBe("alpha");
			const full = await readDecisions({ workspaceId: "ws-1", includeDecided: true }, context as never);
			expect(full.sessions[0]!.entries.length).toBe(2);
		} finally {
			if (prevHome !== undefined) process.env.HOME = prevHome;
			rmSync(home, { recursive: true, force: true });
		}
	});
});
