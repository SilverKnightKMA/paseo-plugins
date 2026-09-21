import { describe, expect, test } from "bun:test";
import { TokenRegistry } from "./tokens.js";

describe("TokenRegistry", () => {
  test("mint then verify roundtrip", () => {
    const r = new TokenRegistry();
    const t = r.mint("parent-1", "scout");
    const c = r.verify(t);
    expect(c).not.toBeNull();
    expect(c!.parentId).toBe("parent-1");
    expect(c!.title).toBe("scout");
  });

  test("wrong or missing token is null", () => {
    const r = new TokenRegistry();
    r.mint("parent-1", "scout");
    expect(r.verify("deadbeef")).toBeNull();
    expect(r.verify(null)).toBeNull();
    expect(r.verify("")).toBeNull();
  });

  test("tokens are long and unique", () => {
    const r = new TokenRegistry();
    const a = r.mint("p", "a");
    const b = r.mint("p", "b");
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  test("cap evicts oldest", () => {
    const r = new TokenRegistry();
    const first = r.mint("p", "first");
    for (let i = 0; i < 1100; i++) r.mint("p", `gen-${i}`);
    expect(r.verify(first)).toBeNull(); // evicted
    expect(r.size).toBeLessThanOrEqual(1024);
  });

  // ---- adopt (spec v12 pa1 — durability token sau restart) ----

  function fakeMintedToken(): string {
    // Sinh token thật cùng format 48-hex như cryptoRandomToken
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  test("adopt: đăng ký lại token cũ, verify sống lại, bind ngay", () => {
    const r = new TokenRegistry();
    const old = fakeMintedToken();
    const entry = r.adopt(old, { parentId: "main-1", title: "scout", depth: 1, canSpawn: false, role: "scout", boundAgentId: "child-9" });
    expect(entry.token).toBe(old); // CÙNG token string — không mint mới
    const c = r.verify(old);
    expect(c).not.toBeNull();
    expect(c!.parentId).toBe("main-1");
    expect(c!.boundAgentId).toBe("child-9");
    expect(c!.canSpawn).toBe(false);
  });

  test("adopt: idempotent — token đã có thì trả entry hiện tại", () => {
    const r = new TokenRegistry();
    const old = fakeMintedToken();
    const a1 = r.adopt(old, { parentId: "p", title: "t1" });
    const a2 = r.adopt(old, { parentId: "p", title: "t2" });
    expect(a2).toBe(a1); // không đè entry cũ
    expect(r.size).toBe(1);
  });

  test("adopt: token sai format bị từ chối", () => {
    const r = new TokenRegistry();
    expect(() => r.adopt("not-a-token", { parentId: "p", title: "t" })).toThrow();
    expect(() => r.adopt("", { parentId: "p", title: "t" })).toThrow();
    // hex đúng nhưng ngắn (24 chars) — cũng sai format
    expect(() => r.adopt("a".repeat(24), { parentId: "p", title: "t" })).toThrow();
  });

  test("adopt: registry đầy thì THROW (fail-closed, không evict thầm lặng)", () => {
    const r = new TokenRegistry();
    for (let i = 0; i < 1024; i++) r.mint("p", `gen-${i}`);
    expect(r.size).toBe(1024);
    expect(() => r.adopt(fakeMintedToken(), { parentId: "p", title: "late" })).toThrow(/đầy/);
    expect(r.size).toBe(1024); // không evict, không thêm
  });
});
