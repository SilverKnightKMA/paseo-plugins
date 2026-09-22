import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doorStatePath, grantsPath, GrantStore, readDoorState, writeDoorState } from "./door-state.js";
import { TokenRegistry } from "./tokens.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "door-state-test-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("door-state.json (F10 #219)", () => {
  test("writeDoorState → readDoorState roundtrip; invalid/corrupt files read as null", () => {
    writeDoorState(dir, 40579);
    expect(readDoorState(dir)?.port).toBe(40579);
    expect(existsSync(doorStatePath(dir))).toBe(true);
    expect(existsSync(`${doorStatePath(dir)}.tmp`)).toBe(false); // atomic — no residue

    // Corrupt JSON degrades to null (best-effort read).
    const file = doorStatePath(dir);
    const saved = readFileSync(file, "utf-8");
    require("node:fs").writeFileSync(file, "{not json");
    expect(readDoorState(dir)).toBeNull();
    require("node:fs").writeFileSync(file, saved);

    // Out-of-range / non-integer ports are rejected.
    require("node:fs").writeFileSync(file, JSON.stringify({ port: 0 }));
    expect(readDoorState(dir)).toBeNull();
    require("node:fs").writeFileSync(file, JSON.stringify({ port: 70000 }));
    expect(readDoorState(dir)).toBeNull();
    require("node:fs").writeFileSync(file, JSON.stringify({ port: 1.5 }));
    expect(readDoorState(dir)).toBeNull();
  });
});

describe("GrantStore (F10 #219)", () => {
  test("persist → restore roundtrip; markNotified survives and only touches its agent", () => {
    const store = new GrantStore(dir);
    expect(store.restore("agent-1")).toBeNull();
    store.persist("agent-1", "a".repeat(48), "Main One");
    const e = store.entryFor("agent-1")!;
    expect(e.token).toBe("a".repeat(48));
    expect(e.title).toBe("Main One");
    expect(e.lastNotifiedPort).toBeUndefined();
    store.markNotified("agent-1", 40579);
    expect(store.entryFor("agent-1")?.lastNotifiedPort).toBe(40579);
    expect(store.entryFor("agent-2")).toBeNull();
    expect(existsSync(grantsPath(dir))).toBe(true);
  });

  test("adoptAll re-registers persisted tokens in a fresh registry (restart simulation)", () => {
    const store = new GrantStore(dir);
    store.persist("agent-r", "b".repeat(48), "Restarted Main");
    const fresh = new TokenRegistry();
    const adopted = store.adoptAll(fresh);
    expect(adopted).toBeGreaterThanOrEqual(1);
    const c = fresh.verify("b".repeat(48))!;
    expect(c.boundAgentId).toBe("agent-r");
    expect(c.canSpawn).toBe(true);
    expect(c.depth).toBe(0);
  });

  test("adoptAll skips invalid tokens without throwing", () => {
    const store = new GrantStore(dir);
    store.persist("agent-bad", "zzz-not-hex", "Bad");
    const fresh = new TokenRegistry();
    expect(() => store.adoptAll(fresh)).not.toThrow();
    expect(fresh.verify("zzz-not-hex")).toBeNull();
  });
});
