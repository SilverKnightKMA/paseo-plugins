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
});
