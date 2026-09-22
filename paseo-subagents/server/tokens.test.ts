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

  // ---- adopt (spec v12 pa1 — token durability after restart) ----

  function fakeMintedToken(): string {
    // Generate a real token in the same 48-hex format as cryptoRandomToken.
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  test("adopt: registers an old token again, restores verification, and binds immediately", () => {
    const r = new TokenRegistry();
    const old = fakeMintedToken();
    const entry = r.adopt(old, { parentId: "main-1", title: "scout", depth: 1, canSpawn: false, role: "scout", boundAgentId: "child-9" });
    expect(entry.token).toBe(old); // SAME token string — no new token is minted.
    const c = r.verify(old);
    expect(c).not.toBeNull();
    expect(c!.parentId).toBe("main-1");
    expect(c!.boundAgentId).toBe("child-9");
    expect(c!.canSpawn).toBe(false);
  });

  test("adopt: idempotent — returns the existing entry when the token is already present", () => {
    const r = new TokenRegistry();
    const old = fakeMintedToken();
    const a1 = r.adopt(old, { parentId: "p", title: "t1" });
    const a2 = r.adopt(old, { parentId: "p", title: "t2" });
    expect(a2).toBe(a1); // Do not overwrite the old entry.
    expect(r.size).toBe(1);
  });

  test("adopt: rejects invalid token formats", () => {
    const r = new TokenRegistry();
    expect(() => r.adopt("not-a-token", { parentId: "p", title: "t" })).toThrow();
    expect(() => r.adopt("", { parentId: "p", title: "t" })).toThrow();
    // Valid hex but too short (24 chars) is also invalid.
    expect(() => r.adopt("a".repeat(24), { parentId: "p", title: "t" })).toThrow();
  });

  test("adopt: THROWS when the registry is full (fail-closed, no silent eviction)", () => {
    const r = new TokenRegistry();
    for (let i = 0; i < 1024; i++) r.mint("p", `gen-${i}`);
    expect(r.size).toBe(1024);
    expect(() => r.adopt(fakeMintedToken(), { parentId: "p", title: "late" })).toThrow(/full/);
    expect(r.size).toBe(1024); // Do not evict or add anything.
  });
});

describe("#226 providerModel identity", () => {
  test("mint stores providerModel; verify returns it", () => {
    const r = new TokenRegistry();
    const t = r.mint("p1", "scout-1", { role: "scout", providerModel: "pi/cli-openai/mmcp/MiniMax-M3" });
    const caps = r.verify(t);
    expect(caps?.providerModel).toBe("pi/cli-openai/mmcp/MiniMax-M3");
    expect(caps?.role).toBe("scout");
  });

  test("adopt restores providerModel from disk metadata", () => {
    const r = new TokenRegistry();
    const t = "a".repeat(48);
    const entry = r.adopt(t, { parentId: "p1", title: "codex-1", role: "codex-worker", providerModel: "codex/gpt-5.6-luna", boundAgentId: "241ba765-80c2-406d-b3a2-41387cd6abed" });
    expect(entry.providerModel).toBe("codex/gpt-5.6-luna");
    expect(r.verify(t)?.boundAgentId?.slice(0, 8)).toBe("241ba765");
  });
});
