// #39 Phase 2 — plugin→engine poke util tests (task copy; ships byte-identical
// to snip/memory/plan via check-shared-ui.py).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { engineBridgesDir, pokeEngineBridges } from "./doorbell-poke.ts";

function listen(dir: string, name: string): Promise<{ lines: string[]; close: () => Promise<void> }> {
	return new Promise((resolve, reject) => {
		const path = join(dir, `${name}.sock`);
		const lines: string[] = [];
		const server = createServer((conn) => {
			let buf = "";
			conn.on("data", (d) => (buf += d.toString()));
			conn.on("close", () => {
				for (const l of buf.split("\n")) if (l.trim()) lines.push(l);
			});
		});
		server.listen(path, () =>
			resolve({
				lines,
				close: () => new Promise<void>((r) => server.close(() => r())),
			}),
		);
		server.on("error", reject);
	});
}

describe("doorbell-poke #39 Phase 2 — plugin writer bell", () => {
	test("missing bridges dir = silent no-op (engine down)", async () => {
		await pokeEngineBridges("task-control", "/tmp/c.json", "s1", { dir: "/tmp/definitely-missing-bridges" });
		expect(true).toBe(true); // no throw = contract
	});

	test("fan-out: every engine socket receives exactly one v1 payload line", async () => {
		const dir = mkdtempSync(join(tmpdir(), "poke-"));
		try {
			const a = await listen(dir, "sess-1");
			const b = await listen(dir, "sess-2");
			await pokeEngineBridges("plan-control", "/tmp/p.json", "sess-1", { dir });
			await new Promise((r) => setTimeout(r, 150));
			for (const { lines } of [a, b]) {
				expect(lines.length).toBe(1);
				const p = JSON.parse(lines[0]);
				expect(p.v).toBe(1);
				expect(p.kind).toBe("plan-control");
				expect(p.file).toBe("/tmp/p.json");
				expect(p.sessionId).toBe("sess-1");
			}
			await a.close();
			await b.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("dead .sock entry skipped; empty sessionId allowed (global files)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "poke-"));
		try {
			const { writeFileSync } = await import("node:fs");
			writeFileSync(join(dir, "dead.sock"), "x");
			const a = await listen(dir, "sess-1");
			await pokeEngineBridges("facts-control", "/tmp/f.json", "", { dir });
			await new Promise((r) => setTimeout(r, 150));
			expect(a.lines.length).toBe(1);
			expect(JSON.parse(a.lines[0]).sessionId).toBe("");
			await a.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("engineBridgesDir default resolves under HOME", () => {
		expect(engineBridgesDir()).toContain(join(".pi", "agent", "bridges"));
		expect(engineBridgesDir({ dir: "/tmp/x" })).toBe("/tmp/x");
	});
});
