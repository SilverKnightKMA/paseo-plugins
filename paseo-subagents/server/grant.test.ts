import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doorGrantMessage, envDoorUrlForMain, GrantLedger, mintDoorForMain, readMainDoorState, shouldGrant } from "./grant.js";
import { TokenRegistry } from "./tokens.js";

let root: string;

function writeRecord(ws: string, id: string, body: Record<string, unknown>): void {
  const dir = join(root, ws);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(body));
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "grant-test-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function fakeRt(port: number | null, logLines: string[] = []) {
  return {
    registry: new TokenRegistry(),
    getPort: () => port,
    allowFull: false,
    log: (m: string) => logLines.push(m),
  };
}

describe("readMainDoorState + shouldGrant (#155)", () => {
  test("an older main with NO door → shouldGrant=true (session cf76ad71 case)", () => {
    writeRecord("ws", "main-old", { id: "main-old", title: "old main", labels: {}, config: { mcpServers: {} } });
    const s = readMainDoorState(root, "main-old");
    expect(s).toEqual({ found: true, isChild: false, archived: false, hasDoor: false });
    expect(shouldGrant(s)).toBe(true);
  });

  test("a main that ALREADY has a door in its record → shouldGrant=false (do not overwrite another door)", () => {
    writeRecord("ws", "main-new", {
      id: "main-new",
      labels: {},
      config: { mcpServers: { "paseo-subagents": { url: "http://127.0.0.1:1/mcp?caller=abc" } } },
    });
    expect(shouldGrant(readMainDoorState(root, "main-new"))).toBe(false);
  });

  test("child (label subagent.parent) → false", () => {
    writeRecord("ws", "child-x", {
      id: "child-x",
      labels: { "subagent.parent": "p1" },
      config: { mcpServers: { paseo: { url: "http://127.0.0.1:1/mcp?caller=def" } } },
    });
    const s = readMainDoorState(root, "child-x");
    expect(s.isChild).toBe(true);
    expect(shouldGrant(s)).toBe(false);
  });

  test("an archived main without a door → false", () => {
    writeRecord("ws", "main-gone", { id: "main-gone", labels: {}, archivedAt: "2026-09-01T00:00:00.000Z", config: {} });
    const s = readMainDoorState(root, "main-gone");
    expect(s.archived).toBe(true);
    expect(shouldGrant(s)).toBe(false);
  });

  test("a missing record or invalid JSON → found=false, false", () => {
    expect(readMainDoorState(root, "ghost").found).toBe(false);
    // Write invalid JSON directly.
    writeFileSync(join(root, "ws", "broken.json"), "{oops");
    expect(readMainDoorState(root, "broken").found).toBe(false);
    expect(shouldGrant({ found: false, isChild: false, archived: false, hasDoor: false })).toBe(false);
  });
});

describe("GrantLedger (#155/#157)", () => {
  test("runs exactly once per process per agent and stores the token", () => {
    const l = new GrantLedger();
    expect(l.allow("a")).toBe(true);
    l.mark("a", "tok-a");
    expect(l.allow("a")).toBe(false);
    expect(l.tokenFor("a")).toBe("tok-a");
    expect(l.tokenFor("b")).toBeNull();
    expect(l.allow("b")).toBe(true);
    expect(l.size).toBe(1);
  });
});

describe("envDoorUrlForMain — L2 reuses the L1 token (#157)", () => {
  test("main without a door: L2 mints and marks the ledger; another call REUSES the token (no double mint)", () => {
    writeRecord("ws2", "main-l2", { id: "main-l2", title: "l2 main", labels: {}, config: { mcpServers: {} } });
    const rt = fakeRt(43721);
    const l = new GrantLedger();
    const u1 = envDoorUrlForMain(root, rt, l, "main-l2", "l2 main");
    expect(u1).not.toBeNull();
    const t1 = new URL(u1!).searchParams.get("caller")!;
    expect(rt.registry.verify(t1)!.boundAgentId).toBe("main-l2");
    expect(l.tokenFor("main-l2")).toBe(t1);
    const before = rt.registry.size;
    const u2 = envDoorUrlForMain(root, rt, l, "main-l2", "l2 main");
    expect(u2).toBe(`http://127.0.0.1:43721/mcp?caller=${t1}`); // Same token.
    expect(rt.registry.size).toBe(before); // Do NOT mint another token.
  });

  test("a main that already has a door in its record → null (L2 skips it)", () => {
    const rt = fakeRt(43721);
    expect(envDoorUrlForMain(root, rt, new GrantLedger(), "main-new", "t")).toBeNull();
  });

  test("child / archived → null", () => {
    const rt = fakeRt(43721);
    expect(envDoorUrlForMain(root, rt, new GrantLedger(), "child-x", "t")).toBeNull();
    expect(envDoorUrlForMain(root, rt, new GrantLedger(), "main-gone", "t")).toBeNull();
  });
});

describe("mintDoorForMain + doorGrantMessage (#155)", () => {
  test("mints with depth 0 and canSpawn, binds agentId IMMEDIATELY, and includes the token in the URL", () => {
    const logs: string[] = [];
    const rt = fakeRt(43721, logs);
    const url = mintDoorForMain(rt, "main-old", "old main");
    expect(url).not.toBeNull();
    const token = new URL(url!).searchParams.get("caller")!;
    expect(url).toBe(`http://127.0.0.1:43721/mcp?caller=${token}`);
    const c = rt.registry.verify(token)!;
    expect(c.canSpawn).toBe(true);
    expect(c.depth).toBe(0);
    expect(c.parentId).toBe("main-old"); // parentId = agentId (not '(main)').
    expect(c.boundAgentId).toBe("main-old");
    expect(logs.some((l) => l.includes("door-grant mint"))).toBe(true);
  });

  test("a null port (door not listening) → null, with NO mint", () => {
    const rt = fakeRt(null);
    expect(mintDoorForMain(rt, "main-old", "t")).toBeNull();
    expect(rt.registry.size).toBe(0);
  });

  test("doorGrantMessage formats '[door-grant] <url>'", () => {
    expect(doorGrantMessage("http://x/mcp?caller=t1")).toBe("[door-grant] http://x/mcp?caller=t1");
  });
});
