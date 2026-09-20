import { describe, expect, test } from "bun:test";
import { checkFloor, isNormalizedMode, providerFamily, translateMode } from "./mode-table.js";

describe("providerFamily", () => {
  test("strips model suffix", () => {
    expect(providerFamily("codex/gpt-5.6-luna")).toBe("codex");
    expect(providerFamily("claude/opus-4.x")).toBe("claude");
  });
  test("bare provider stays", () => {
    expect(providerFamily("pi")).toBe("pi");
    expect(providerFamily("codex")).toBe("codex");
  });
});

describe("translateMode", () => {
  test("codex table", () => {
    expect(translateMode("codex/x", "read-only").modeId).toBe("read-only");
    expect(translateMode("codex/x", "auto").modeId).toBe("auto");
    expect(translateMode("codex/x", "review").modeId).toBe("auto-review");
    expect(translateMode("codex/x", "full").modeId).toBe("full-access");
  });
  test("claude table", () => {
    expect(translateMode("claude/x", "read-only").modeId).toBe("plan");
    expect(translateMode("claude/x", "auto").modeId).toBe("default");
    expect(translateMode("claude/x", "review").modeId).toBe("auto");
    expect(translateMode("claude/x", "full").modeId).toBe("bypassPermissions");
  });
  test("pi never emits modeId", () => {
    for (const mode of ["read-only", "auto", "review", "full"] as const) {
      const d = translateMode("pi", mode);
      expect(d.modeId).toBeUndefined();
      expect(d.warning).toBeTruthy();
    }
  });
  test("unknown provider warns honestly", () => {
    const d = translateMode("factory/whatever", "auto");
    expect(d.modeId).toBeUndefined();
    expect(d.providerKnown).toBe(false);
    expect(d.warning).toContain("factory");
  });
});

describe("checkFloor (fail-closed)", () => {
  test("full refused without opt-in, even for known provider", () => {
    const d = checkFloor("codex/x", "full", false);
    expect(d.ok).toBe(false);
    expect(d.reason).toContain("SUBAGENT_REPLY_ALLOW_FULL");
  });
  test("full allowed for known provider with opt-in", () => {
    expect(checkFloor("codex/x", "full", true).ok).toBe(true);
  });
  test("full ALWAYS refused for provider without verified table", () => {
    const d = checkFloor("factory/x", "full", true);
    expect(d.ok).toBe(false);
    expect(d.reason).toContain("no verified mode table");
  });
  test("contained modes pass everywhere", () => {
    for (const p of ["codex/x", "claude/x", "pi", "factory/x"]) {
      for (const m of ["read-only", "auto", "review"] as const) {
        expect(checkFloor(p, m, false).ok).toBe(true);
      }
    }
  });
});

describe("isNormalizedMode", () => {
  test("accepts the four knobs", () => {
    expect(isNormalizedMode("auto")).toBe(true);
  });
  test("rejects provider jargon and junk", () => {
    expect(isNormalizedMode("full-access")).toBe(false);
    expect(isNormalizedMode("bypassPermissions")).toBe(false);
    expect(isNormalizedMode(undefined)).toBe(false);
  });
});
