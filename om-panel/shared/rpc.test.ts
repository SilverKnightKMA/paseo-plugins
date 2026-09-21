import { describe, expect, test } from "bun:test";
import { TopicFileSchema, SessionDetailSchema, SessionBriefSchema } from "./rpc.js";

/**
 * #100 step 3 (v1.0.75): topic rows already render `kb` + `modified` (updatedAt
 * + size) — added after the 2026-09-16 gap audit. These tests PIN the wire
 * contract so a future schema change cannot silently drop either column from
 * the om-panel Topic files list.
 */

describe("om-panel topic row contract (#100 step 3)", () => {
	test("TopicFileSchema requires file + kb + modified", () => {
		const t = TopicFileSchema.parse({ file: "memory-architecture.md", kb: 12.4, modified: "2026-09-21T16:22:00.000Z" });
		expect(t.file).toBe("memory-architecture.md");
		expect(t.kb).toBe(12.4);
		expect(t.modified).toBe("2026-09-21T16:22:00.000Z");
		// missing either column is a schema error — the panel row cannot render half a row
		expect(() => TopicFileSchema.parse({ file: "x.md", kb: 1 })).toThrow();
		expect(() => TopicFileSchema.parse({ file: "x.md", modified: "z" })).toThrow();
	});

	test("SessionDetailSchema carries the topics array with both columns", () => {
		const s = SessionDetailSchema.parse({
			sessionId: "sess-1",
			topicFiles: 2,
			totalKb: 30.5,
			lastModified: "2026-09-21T10:00:00.000Z",
			indexHead: ["# index"],
			topics: [
				{ file: "a.md", kb: 1.5, modified: "2026-09-20T00:00:00.000Z" },
				{ file: "b.md", kb: 29, modified: "2026-09-21T10:00:00.000Z" },
			],
		});
		expect(s.topics).toHaveLength(2);
		expect(s.topics.every((t) => typeof t.kb === "number" && typeof t.modified === "string")).toBe(true);
		expect(s.topicFiles).toBe(s.topics.length);
	});

	test("SessionBriefSchema defaults title to null (pre-title projections)", () => {
		const b = SessionBriefSchema.parse({
			sessionId: "sess-2",
			topicFiles: 0,
			totalKb: 0,
			lastModified: null,
			active: false,
		});
		expect(b.title).toBeNull();
	});
});
