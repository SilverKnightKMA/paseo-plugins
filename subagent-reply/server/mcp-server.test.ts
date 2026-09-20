import { afterAll, describe, expect, test } from "bun:test";
import { TokenRegistry } from "./tokens.js";
import { startReplyServer, type McpRuntime } from "./mcp-server.js";

const registry = new TokenRegistry();
const deliveries: Array<{ parentId: string; title: string; prompt: string }> = [];
const runtime: McpRuntime = await startReplyServer({
  registry,
  deliver: async (parentId, title, prompt) => {
    if (prompt === "FORCE-FAIL") throw new Error("forced delivery failure");
    deliveries.push({ parentId, title, prompt });
  },
});
const base = `http://127.0.0.1:${runtime.port}/mcp`;
const TOKEN = registry.mint("parent-abc", "e2e-child");

afterAll(async () => {
  await runtime.close();
});

let rpcId = 0;
async function rpc(method: string, params?: unknown, token: string = TOKEN): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}?caller=${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("scoped reply MCP server", () => {
  test("initialize handshake", async () => {
    const r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    expect(r.status).toBe(200);
    expect(r.body.result.serverInfo.name).toBe("paseo-subagent-reply");
    expect(r.body.result.protocolVersion).toBe("2025-06-18");
  });

  test("unknown protocol version falls back to a supported one", async () => {
    const r = await rpc("initialize", { protocolVersion: "1999-01-01" });
    expect(["2025-06-18", "2025-03-26", "2024-11-05"]).toContain(r.body.result.protocolVersion);
  });

  test("tools/list exposes exactly one tool", async () => {
    const r = await rpc("tools/list");
    expect(r.body.result.tools).toHaveLength(1);
    expect(r.body.result.tools[0].name).toBe("reply_to_parent");
    expect(r.body.result.tools[0].inputSchema.required).toEqual(["prompt"]);
  });

  test("reply_to_parent delivers with caller identity bound at mint", async () => {
    const r = await rpc("tools/call", { name: "reply_to_parent", arguments: { prompt: "hello from child" } });
    expect(r.body.result.isError).toBe(false);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toEqual({ parentId: "parent-abc", title: "e2e-child", prompt: "hello from child" });
  });

  test("no agentId parameter exists anywhere — destination is unaddressable", async () => {
    const r = await rpc("tools/call", { name: "reply_to_parent", arguments: { prompt: "x", agentId: "other-agent" } });
    // additionalProperties:false is declared in schema; enforcement happens client-side,
    // server-side we still deliver to the ONLY possible destination: minted parent.
    expect(r.body.result.isError).toBe(false);
    expect(deliveries[deliveries.length - 1].parentId).toBe("parent-abc");
  });

  test("unknown tool -> honest error naming the only tool", async () => {
    const r = await rpc("tools/call", { name: "send_agent_prompt", arguments: { prompt: "x" } });
    expect(r.body.error).toBeDefined();
    expect(r.body.error.message).toContain("only reply_to_parent");
  });

  test("missing prompt -> structured invalid-arguments error", async () => {
    const r = await rpc("tools/call", { name: "reply_to_parent", arguments: {} });
    expect(r.body.error).toBeDefined();
    expect(r.body.error.message).toContain("prompt");
  });

  test("delivery failure -> isError:true with reason (no fake success)", async () => {
    const r = await rpc("tools/call", { name: "reply_to_parent", arguments: { prompt: "FORCE-FAIL" } });
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.content[0].text).toContain("forced delivery failure");
  });

  test("wrong token -> 401 honest reject", async () => {
    const r = await rpc("tools/list", undefined, "not-a-real-token");
    expect(r.status).toBe(401);
    expect(r.body.error.message).toContain("unknown or expired caller");
  });

  test("no token -> 401", async () => {
    const res = await fetch(base, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  test("GET -> 405 (stateless, no SSE)", async () => {
    const res = await fetch(`${base}?caller=${TOKEN}`, { method: "GET" });
    expect(res.status).toBe(405);
  });

  test("notification (no id) -> 202 empty", async () => {
    const res = await fetch(`${base}?caller=${TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  test("invalid JSON -> -32700", async () => {
    const res = await fetch(`${base}?caller=${TOKEN}`, { method: "POST", body: "{not json" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32700);
  });

  test("ping works", async () => {
    const r = await rpc("ping");
    expect(r.body.result).toEqual({});
  });

  test("two children with different tokens cannot cross-talk", async () => {
    const other = registry.mint("parent-OTHER", "other-child");
    await rpc("tools/call", { name: "reply_to_parent", arguments: { prompt: "from other" } }, other);
    expect(deliveries[deliveries.length - 1].parentId).toBe("parent-OTHER");
    // first child's token still delivers to ITS parent only
    await rpc("tools/call", { name: "reply_to_parent", arguments: { prompt: "from first" } });
    expect(deliveries[deliveries.length - 1].parentId).toBe("parent-abc");
  });
});
