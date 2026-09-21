import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doorGrantMessage, GrantLedger, mintDoorForMain, readMainDoorState, shouldGrant } from "./grant.js";
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
  test("main cũ KHÔNG door → shouldGrant=true (đúng case session cf76ad71)", () => {
    writeRecord("ws", "main-old", { id: "main-old", title: "old main", labels: {}, config: { mcpServers: {} } });
    const s = readMainDoorState(root, "main-old");
    expect(s).toEqual({ found: true, isChild: false, archived: false, hasDoor: false });
    expect(shouldGrant(s)).toBe(true);
  });

  test("main ĐÃ có door trong record → shouldGrant=false (không đè door ai)", () => {
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

  test("archived main không door → false", () => {
    writeRecord("ws", "main-gone", { id: "main-gone", labels: {}, archivedAt: "2026-09-01T00:00:00.000Z", config: {} });
    const s = readMainDoorState(root, "main-gone");
    expect(s.archived).toBe(true);
    expect(shouldGrant(s)).toBe(false);
  });

  test("không có record / JSON hỏng → found=false, false", () => {
    expect(readMainDoorState(root, "ghost").found).toBe(false);
    // ghi JSON hỏng trực tiếp
    writeFileSync(join(root, "ws", "broken.json"), "{oops");
    expect(readMainDoorState(root, "broken").found).toBe(false);
    expect(shouldGrant({ found: false, isChild: false, archived: false, hasDoor: false })).toBe(false);
  });
});

describe("GrantLedger (#155)", () => {
  test("đúng 1 lần mỗi process mỗi agent", () => {
    const l = new GrantLedger();
    expect(l.allow("a")).toBe(true);
    l.mark("a");
    expect(l.allow("a")).toBe(false);
    expect(l.allow("b")).toBe(true);
    expect(l.size).toBe(1);
  });
});

describe("mintDoorForMain + doorGrantMessage (#155)", () => {
  test("mint depth0 canSpawn, bind NGAY agentId, URL chứa token", () => {
    const logs: string[] = [];
    const rt = fakeRt(43721, logs);
    const url = mintDoorForMain(rt, "main-old", "old main");
    expect(url).not.toBeNull();
    const token = new URL(url!).searchParams.get("caller")!;
    expect(url).toBe(`http://127.0.0.1:43721/mcp?caller=${token}`);
    const c = rt.registry.verify(token)!;
    expect(c.canSpawn).toBe(true);
    expect(c.depth).toBe(0);
    expect(c.parentId).toBe("main-old"); // parentId = agentId (không phải '(main)')
    expect(c.boundAgentId).toBe("main-old");
    expect(logs.some((l) => l.includes("door-grant mint"))).toBe(true);
  });

  test("port null (door chưa listen) → null, KHÔNG mint", () => {
    const rt = fakeRt(null);
    expect(mintDoorForMain(rt, "main-old", "t")).toBeNull();
    expect(rt.registry.size).toBe(0);
  });

  test("doorGrantMessage định dạng '[door-grant] <url>'", () => {
    expect(doorGrantMessage("http://x/mcp?caller=t1")).toBe("[door-grant] http://x/mcp?caller=t1");
  });
});
