import { describe, expect, test } from "bun:test";
import { deriveLocalUrl, armBackstop } from "./backstop.js";

describe("#277 direct backstop client (post-reload self-heal)", () => {
	test("deriveLocalUrl: default, env listen, 0.0.0.0 mapped to loopback, empty", () => {
		expect(deriveLocalUrl(undefined)).toBe("http://127.0.0.1:6767");
		expect(deriveLocalUrl("127.0.0.1:6767")).toBe("http://127.0.0.1:6767");
		expect(deriveLocalUrl("0.0.0.0:6767")).toBe("http://127.0.0.1:6767");
		expect(deriveLocalUrl("")).toBe("http://127.0.0.1:6767");
		expect(deriveLocalUrl("192.168.1.5:7000")).toBe("http://192.168.1.5:7000");
	});

	test("armBackstop: refused port → ready resolves false within the arm timeout, isConnected stays live", async () => {
		const h = armBackstop({ PASEO_SUBAGENTS_DIRECT_URL: "http://127.0.0.1:1" }, 400);
		expect(h).not.toBeNull();
		if (!h) return;
		expect(typeof (h.client as { agents: unknown }).agents).toBe("object");
		expect(await h.ready).toBe(false);
		expect(h.isConnected()).toBe(false); // a late retry can still unlock it
	});
});
