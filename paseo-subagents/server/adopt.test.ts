import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptFromRecord, findRecordByToken } from "./adopt.js";
import { TokenRegistry } from "./tokens.js";

/** Sinh token thật cùng format 48-hex như cryptoRandomToken. */
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
  // Main có door ở key 'paseo-subagents'
  writeRecord("ws-a", "main-1111", {
    id: "main-1111",
    title: "e2e main",
    labels: {},
    config: { mcpServers: { "paseo-subagents": { type: "http", url: `http://127.0.0.1:43721/mcp?caller=${MAIN_T}` } } },
  });
  // Child có door ở key 'paseo' + labels subagent.*
  writeRecord("ws-a", "child-2222", {
    id: "child-2222",
    title: "scout echo",
    labels: { "subagent.parent": "main-1111", "subagent.depth": "1", "subagent.role": "scout" },
    config: { mcpServers: { paseo: { type: "http", url: `http://127.0.0.1:43721/mcp?caller=${CHILD_T}` } } },
  });
  // Main đã archived — token vẫn nhận được nhưng hit.archived=true
  writeRecord("ws-b", "main-archived", {
    id: "main-archived",
    title: "old main",
    labels: {},
    archivedAt: "2026-09-19T00:00:00.000Z",
    config: { mcpServers: { "paseo-subagents": { type: "http", url: `http://127.0.0.1:43721/mcp?caller=${ARCHIVED_MAIN_T}` } } },
  });
  // JSON hỏng (đang ghi dở) — phải bị bỏ qua im lặng
  mkdirSync(join(root, "ws-b"), { recursive: true });
  writeFileSync(join(root, "ws-b", "broken-9999.json"), "{not json at all");
  // Agent không door-hóa — bỏ qua
  writeRecord("ws-b", "plain-8888", { id: "plain-8888", title: "no door", labels: {}, config: { mcpServers: {} } });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("findRecordByToken (pa1 #154)", () => {
  test("tìm main theo token — hit đầy đủ, archived=false", () => {
    const hit = findRecordByToken(root, MAIN_T);
    expect(hit).not.toBeNull();
    expect(hit!.agentId).toBe("main-1111");
    expect(hit!.isChild).toBe(false);
    expect(hit!.archived).toBe(false);
    expect(hit!.url).toContain(`caller=${MAIN_T}`);
  });

  test("tìm child — isChild, depth/role từ labels", () => {
    const hit = findRecordByToken(root, CHILD_T);
    expect(hit!.agentId).toBe("child-2222");
    expect(hit!.isChild).toBe(true);
    expect(hit!.depth).toBe(1);
    expect(hit!.role).toBe("scout");
  });

  test("record archived vẫn hit (archived=true) — token chưa chắc chết", () => {
    const hit = findRecordByToken(root, ARCHIVED_MAIN_T);
    expect(hit!.agentId).toBe("main-archived");
    expect(hit!.archived).toBe(true);
  });

  test("token không có trong record nào → null (401 như cũ)", () => {
    expect(findRecordByToken(root, UNKNOWN_T)).toBeNull();
  });

  test("token sai format → null không quét", () => {
    expect(findRecordByToken(root, "garbage")).toBeNull();
    expect(findRecordByToken(root, "")).toBeNull();
  });

  test("chống prefix-match: token chung đầu nhưng khác đuôi không khớp", () => {
    // MAIN_T + 'ff' đè cuối — 50 chars, không phải token nào trong record
    expect(findRecordByToken(root, `${MAIN_T}ff`)).toBeNull();
  });

  test("JSON hỏng + record không door bị bỏ qua im lặng", () => {
    // broken-9999 và plain-8888 không làm nổ scan; MAIN_T vẫn tìm thấy
    expect(findRecordByToken(root, MAIN_T)!.agentId).toBe("main-1111");
  });
});

describe("adoptFromRecord (pa1 #154)", () => {
  test("main: adopt CÙNG token → verify sống lại, canSpawn=true depth 0, bind agentId", () => {
    const r = new TokenRegistry();
    const res = adoptFromRecord(root, MAIN_T, r);
    expect(res).toEqual({ agentId: "main-1111", isChild: false });
    const c = r.verify(MAIN_T);
    expect(c).not.toBeNull();
    expect(c!.token).toBe(MAIN_T); // cùng token string — không mint mới
    expect(c!.canSpawn).toBe(true);
    expect(c!.depth).toBe(0);
    expect(c!.boundAgentId).toBe("main-1111");
  });

  test("child: canSpawn=false, depth từ label, role giữ nguyên", () => {
    const r = new TokenRegistry();
    const res = adoptFromRecord(root, CHILD_T, r);
    expect(res!.isChild).toBe(true);
    const c = r.verify(CHILD_T)!;
    expect(c.canSpawn).toBe(false);
    expect(c.depth).toBe(1);
    expect(c.role).toBe("scout");
    expect(c.boundAgentId).toBe("child-2222");
  });

  test("token lạ → null, registry rỗng (fail-honest)", () => {
    const r = new TokenRegistry();
    expect(adoptFromRecord(root, UNKNOWN_T, r)).toBeNull();
    expect(r.size).toBe(0);
  });

  test("idempotent: gọi 2 lần vẫn 1 entry", () => {
    const r = new TokenRegistry();
    adoptFromRecord(root, MAIN_T, r);
    adoptFromRecord(root, MAIN_T, r);
    expect(r.size).toBe(1);
  });
});
