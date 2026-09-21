import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptFromRecord, findRecordByToken } from "./adopt.js";
import { TokenRegistry } from "./tokens.js";

/** Generate a real token in the same 48-hex format as cryptoRandomToken. */
function token(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const MAIN_T = token();
const CHILD_T = token();
const ARCHIVED_MAIN_T = token();
const UNKNOWN_T = token();

let root: string;

function writeRecord(ws: string, id: string, body: Record<string, unknown>): void {
  const dir = join(root, ws);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(body));
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "adopt-test-"));
  // Main has a door under the 'paseo-subagents' key.
  writeRecord("ws-a", "main-1111", {
    id: "main-1111",
    title: "e2e main",
    labels: {},
    config: { mcpServers: { "paseo-subagents": { type: "http", url: `http://127.0.0.1:43721/mcp?caller=${MAIN_T}` } } },
  });
  // Child has a door under the 'paseo' key plus subagent.* labels.
  writeRecord("ws-a", "child-2222", {
    id: "child-2222",
    title: "scout echo",
    labels: { "subagent.parent": "main-1111", "subagent.depth": "1", "subagent.role": "scout" },
    config: { mcpServers: { paseo: { type: "http", url: `http://127.0.0.1:43721/mcp?caller=${CHILD_T}` } } },
  });
  // Main is archived — the token is still accepted, but hit.archived=true.
  writeRecord("ws-b", "main-archived", {
    id: "main-archived",
    title: "old main",
    labels: {},
    archivedAt: "2026-09-19T00:00:00.000Z",
    config: { mcpServers: { "paseo-subagents": { type: "http", url: `http://127.0.0.1:43721/mcp?caller=${ARCHIVED_MAIN_T}` } } },
  });
  // Invalid (partially written) JSON must be silently skipped.
  mkdirSync(join(root, "ws-b"), { recursive: true });
  writeFileSync(join(root, "ws-b", "broken-9999.json"), "{not json at all");
  // Skip agents without a door.
  writeRecord("ws-b", "plain-8888", { id: "plain-8888", title: "no door", labels: {}, config: { mcpServers: {} } });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("findRecordByToken (pa1 #154)", () => {
  test("finds a main by token — complete hit, archived=false", () => {
    const hit = findRecordByToken(root, MAIN_T);
    expect(hit).not.toBeNull();
    expect(hit!.agentId).toBe("main-1111");
    expect(hit!.isChild).toBe(false);
    expect(hit!.archived).toBe(false);
    expect(hit!.url).toContain(`caller=${MAIN_T}`);
  });

  test("finds a child — isChild, depth, and role come from labels", () => {
    const hit = findRecordByToken(root, CHILD_T);
    expect(hit!.agentId).toBe("child-2222");
    expect(hit!.isChild).toBe(true);
    expect(hit!.depth).toBe(1);
    expect(hit!.role).toBe("scout");
  });

  test("an archived record still matches (archived=true) — its token may still be valid", () => {
    const hit = findRecordByToken(root, ARCHIVED_MAIN_T);
    expect(hit!.agentId).toBe("main-archived");
    expect(hit!.archived).toBe(true);
  });

  test("a token absent from all records returns null (401 as before)", () => {
    expect(findRecordByToken(root, UNKNOWN_T)).toBeNull();
  });

  test("an invalid token format returns null without scanning", () => {
    expect(findRecordByToken(root, "garbage")).toBeNull();
    expect(findRecordByToken(root, "")).toBeNull();
  });

  test("prevents prefix matches: tokens with the same prefix but different suffixes do not match", () => {
    // MAIN_T + 'ff' appends a suffix — 50 chars, so it is not any token in the records.
    expect(findRecordByToken(root, `${MAIN_T}ff`)).toBeNull();
  });

  test("invalid JSON and records without doors are silently skipped", () => {
    // broken-9999 and plain-8888 do not break the scan; MAIN_T is still found.
    expect(findRecordByToken(root, MAIN_T)!.agentId).toBe("main-1111");
  });
});

describe("adoptFromRecord (pa1 #154)", () => {
  test("main: adopting the SAME token restores verification, canSpawn=true, depth 0, and agentId binding", () => {
    const r = new TokenRegistry();
    const res = adoptFromRecord(root, MAIN_T, r);
    expect(res).toEqual({ agentId: "main-1111", isChild: false });
    const c = r.verify(MAIN_T);
    expect(c).not.toBeNull();
    expect(c!.token).toBe(MAIN_T); // Same token string — no new token is minted.
    expect(c!.canSpawn).toBe(true);
    expect(c!.depth).toBe(0);
    expect(c!.boundAgentId).toBe("main-1111");
  });

  test("child: canSpawn=false, depth comes from the label, and role is preserved", () => {
    const r = new TokenRegistry();
    const res = adoptFromRecord(root, CHILD_T, r);
    expect(res!.isChild).toBe(true);
    const c = r.verify(CHILD_T)!;
    expect(c.canSpawn).toBe(false);
    expect(c.depth).toBe(1);
    expect(c.role).toBe("scout");
    expect(c.boundAgentId).toBe("child-2222");
  });

  test("an unknown token returns null and leaves the registry empty (fail-honest)", () => {
    const r = new TokenRegistry();
    expect(adoptFromRecord(root, UNKNOWN_T, r)).toBeNull();
    expect(r.size).toBe(0);
  });

  test("idempotent: two calls still produce one entry", () => {
    const r = new TokenRegistry();
    adoptFromRecord(root, MAIN_T, r);
    adoptFromRecord(root, MAIN_T, r);
    expect(r.size).toBe(1);
  });
});
