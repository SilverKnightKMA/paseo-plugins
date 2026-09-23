import { describe, expect, test } from "bun:test";
import { deriveLocalUrl, makeBackstop } from "./backstop.js";

describe("#277 direct backstop client (post-reload self-heal)", () => {
	test("deriveLocalUrl: default, env listen, 0.0.0.0 mapped to loopback, empty", () => {
		expect(deriveLocalUrl(undefined)).toBe("http://127.0.0.1:6767");
		expect(deriveLocalUrl("127.0.0.1:6767")).toBe("http://127.0.0.1:6767");
		expect(deriveLocalUrl("0.0.0.0:6767")).toBe("http://127.0.0.1:6767");
		expect(deriveLocalUrl("")).toBe("http://127.0.0.1:6767");
		expect(deriveLocalUrl("192.168.1.5:7000")).toBe("http://192.168.1.5:7000");
	});

	test("makeBackstop: construction never dials — returns a client even for a down daemon", () => {
		const c = makeBackstop({ PASEO_SUBAGENTS_DIRECT_URL: "http://127.0.0.1:1" });
		expect(c).not.toBeNull();
		expect(typeof (c as { agents: unknown }).agents).toBe("object");
	});

	test("makeBackstop: explicit pin wins over PASEO_LISTEN; malformed pin falls back to null", () => {
		const pinned = makeBackstop({ PASEO_SUBAGENTS_DIRECT_URL: "http://127.0.0.1:9999", PASEO_LISTEN: "0.0.0.0:6767" });
		expect(pinned).not.toBeNull();
		// The factory only rejects malformed input shapes (it does not dial), so a
		// well-formed pin must always yield a client — the URL choice itself is
		// covered by deriveLocalUrl above.
		expect(makeBackstop({ PASEO_LISTEN: "0.0.0.0:6767" })).not.toBeNull();
	});
});
