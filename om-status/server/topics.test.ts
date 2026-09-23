import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTopicsForDir } from "./om-status.js";

describe("#244 (M3) readTopicsForDir — the OM Topics source", () => {
	test("lists *.md minus INDEX.md, newest first, head lines capped at 5", async () => {
		const dir = mkdtempSync(join(tmpdir(), "om-topics-"));
		try {
			writeFileSync(join(dir, "INDEX.md"), "# index\nshould not appear\n");
			writeFileSync(join(dir, "alpha.md"), "# Alpha topic\nfirst observation\nsecond observation\nthird\nfourth\nfifth\nsixth-must-not-appear\n");
			await Bun.sleep(10);
			writeFileSync(join(dir, "beta.md"), "# Beta topic\nnewest file observation\n");
			const topics = await readTopicsForDir(dir);
			expect(topics.length).toBe(2);
			expect(topics[0]!.name).toBe("beta.md"); // newest first
			expect(topics[1]!.name).toBe("alpha.md");
			expect(topics[1]!.head.length).toBe(5); // head capped
			expect(topics[1]!.head.join(" ")).not.toContain("sixth-must-not-appear");
			expect(topics[1]!.head[0]).toBe("first observation");
			expect(topics[1]!.sizeBytes).toBeGreaterThan(0);
			expect(typeof topics[0]!.updatedAt).toBe("string");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("empty / missing dir → [] (panel shows the note)", async () => {
		expect(await readTopicsForDir(join(tmpdir(), "om-topics-missing"))).toEqual([]);
		const empty = mkdtempSync(join(tmpdir(), "om-topics-"));
		try {
			expect(await readTopicsForDir(empty)).toEqual([]);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});
});
