import { afterAll, describe, expect, test } from "bun:test";
import { TokenRegistry } from "./tokens.js";
import { startReplyServer, listenReplyServer, type McpRuntime } from "./mcp-server.js";

const registry = new TokenRegistry();
const deliveries: Array<{ parentId: string; title: string; prompt: string; meta?: { callerAgentId?: string } }> = [];
const runtime: McpRuntime = await startReplyServer({
  registry,
  deliver: async (parentId, title, prompt, meta) => {
    if (prompt === "FORCE-FAIL") throw new Error("forced delivery failure");
    deliveries.push({ parentId, title, prompt, meta });
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
    expect(r.body.result.serverInfo.name).toBe("paseo-subagents");
    expect(r.body.result.protocolVersion).toBe("2025-06-18");
  });

  test("unknown protocol version falls back to a supported one", async () => {
    const r = await rpc("initialize", { protocolVersion: "1999-01-01" });
    expect(["2025-06-18", "2025-03-26", "2024-11-05"]).toContain(r.body.result.protocolVersion);
  });

  test("tools/list exposes child toolset (reply + ask_parent)", async () => {
    const r = await rpc("tools/list");
    expect(r.body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["ask_parent", "reply_to_parent"]);
    expect(r.body.result.tools[0].inputSchema.required).toEqual(["prompt"]);
  });

  test("reply_to_parent delivers with caller identity bound at mint", async () => {
    const r = await rpc("tools/call", { name: "reply_to_parent", arguments: { prompt: "hello from child" } });
    expect(r.body.result.isError).toBe(false);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toEqual({ parentId: "parent-abc", title: "e2e-child", prompt: "hello from child", meta: { callerAgentId: undefined } });
  });

  test("#226: deliver title carries role + agentId-8 + providerModel; meta carries callerAgentId", async () => {
    const ident = registry.mint("parent-xyz", "f10-smoke-scout", {
      role: "scout",
      providerModel: "pi/cli-openai/mmcp/MiniMax-M3",
    });
    registry.bind(ident, "a15788c7-a137-4bed-b8fb-9a9e83320151");
    const r = await rpc(
      "tools/call",
      { name: "reply_to_parent", arguments: { prompt: "F10-SCOUT-OK" } },
      ident,
    );
    expect(r.body.result.isError).toBe(false);
    const d = deliveries[deliveries.length - 1];
    expect(d.title).toBe("f10-smoke-scout (scout, a15788c7, pi/cli-openai/mmcp/MiniMax-M3)");
    expect(d.meta?.callerAgentId).toBe("a15788c7-a137-4bed-b8fb-9a9e83320151");
    expect(d.prompt).toBe("F10-SCOUT-OK");
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
    expect(r.body.error.message).toContain("reply_to_parent");
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

// ---- spawn_subagent (spec v11: tool list filtered by caller, detached) ----
import type { TokenRegistry } from "./tokens.js";

async function post(port: number, token: string, body: unknown): Promise<Record<string, unknown> & { result?: { tools?: { name: string }[]; content?: { text?: unknown }[]; isError?: boolean }; error?: { message: string } }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp?caller=${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as never;
}

test("tools/list: canSpawn=false sees only reply_to_parent; main also sees spawn_subagent", async () => {
  const registry = new TokenRegistry();
  const childToken = registry.mint("parent-1", "child", { depth: 1, canSpawn: false });
  const mainToken = registry.mint("(main)", "main", { depth: 0, canSpawn: true });
  const handle = await listenReplyServer({ registry, deliver: async () => {} });
  try {
    const childList = (await post(handle.port, childToken, { jsonrpc: "2.0", id: 1, method: "tools/list" })).result!.tools!;
    expect(childList.map((t) => t.name).sort()).toEqual(["ask_parent", "reply_to_parent"]);
    const mainList = (await post(handle.port, mainToken, { jsonrpc: "2.0", id: 2, method: "tools/list" })).result!.tools!;
    expect(mainList.map((t) => t.name).sort()).toEqual(["answer_child", "reply_to_parent", "spawn_pool", "spawn_subagent"]);
  } finally {
    await handle.close();
  }
});

test("tools/call spawn_subagent: child with canSpawn=false is explicitly refused", async () => {
  const registry = new TokenRegistry();
  const childToken = registry.mint("parent-1", "child", { depth: 1, canSpawn: false });
  let spawnCalls = 0;
  const handle = await listenReplyServer({
    registry,
    deliver: async () => {},
    spawn: async () => { spawnCalls++; return { agentId: "x" }; },
  });
  try {
    const r = await post(handle.port, childToken, {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "spawn_subagent", arguments: { role: "scout", task: "t" } },
    });
    expect(r.error?.message).toContain("canSpawn=false");
    expect(spawnCalls).toBe(0);
  } finally {
    await handle.close();
  }
});

test("tools/call spawn_subagent: main spawn OK, detach shape {agentId,status:running,note}", async () => {
  const registry = new TokenRegistry();
  const mainToken = registry.mint("(main)", "main", { depth: 0, canSpawn: true });
  const handle = await listenReplyServer({
    registry,
    deliver: async () => {},
    spawn: async (caller, args) => {
      expect(caller.depth).toBe(0);
      expect(args.role).toBe("scout");
      return { agentId: "agent-xyz" };
    },
  });
  try {
    const r = await post(handle.port, mainToken, {
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "spawn_subagent", arguments: { role: "scout", task: "map repo" } },
    });
    const text = String(r.result!.content![0].text);
    expect(text).toContain('"agentId":"agent-xyz"');
    expect(text).toContain('"status":"running"');
    expect(text).toContain("[child-report]");
  } finally {
    await handle.close();
  }
});

test("tools/call spawn_subagent: a SpawnFn error (unknown role) returns isError with the reason", async () => {
  const registry = new TokenRegistry();
  const mainToken = registry.mint("(main)", "main", { depth: 0, canSpawn: true });
  const handle = await listenReplyServer({
    registry,
    deliver: async () => {},
    spawn: async () => ({ error: "unknown role 'nope' — available roles: scout" }),
  });
  try {
    const r = await post(handle.port, mainToken, {
      jsonrpc: "2.0", id: 5, method: "tools/call",
      params: { name: "spawn_subagent", arguments: { role: "nope", task: "x" } },
    });
    const text = String(r.result!.content![0].text);
    expect(r.result!.isError).toBe(true);
    expect(text).toContain("available roles");
  } finally {
    await handle.close();
  }
});

// ---- adopt-on-miss (spec v12 pa1 · #158 / plan 8/20) ----

describe("verify-miss adopt (pa1 #158)", () => {
  // Simulate a restart: the NEW registry is empty, and the old token remains only
  // in the "disk record" (a map standing in for adoptFromRecord). The first request
  // must be served IMMEDIATELY.
  test("miss → adopt → serves the request immediately without a client retry", async () => {
    const oldToken = "a".repeat(48).replace(/^a/, "0") + ""; // 48 hex
    const token = Array.from({ length: 48 }, (_, i) => (i % 2 ? "b" : "a")).join("");
    const fresh = new TokenRegistry();
    const adopted: string[] = [];
    const rt2 = await startReplyServer({
      registry: fresh,
      deliver: async () => {},
      adopt: (t) => {
        adopted.push(t);
        fresh.adopt(t, { parentId: "main-old", title: "old main", depth: 0, canSpawn: true, boundAgentId: "main-old" });
        return true;
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${rt2.port}/mcp?caller=${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(200); // Served IMMEDIATELY after adoption.
      expect(adopted).toEqual([token]);
      const list = (await res.json()) as { result: { tools: Array<{ name: string }> } };
      const names = list.result.tools.map((t) => t.name);
      expect(names).toContain("spawn_subagent"); // main canSpawn=true
    } finally {
      await rt2.close();
    }
  });

  test("adopt returns false (record not found) → 401 as before", async () => {
    const fresh = new TokenRegistry();
    const rt3 = await startReplyServer({ registry: fresh, deliver: async () => {}, adopt: () => false });
    try {
      const res = await fetch(`http://127.0.0.1:${rt3.port}/mcp?caller=${"c".repeat(48)}`, { method: "POST", body: "" });
      expect(res.status).toBe(401);
    } finally {
      await rt3.close();
    }
  });

  test("PASEO_SUBAGENTS_ADOPT=0 hatch → does not call adopt and returns 401 directly", async () => {
    const prev = process.env.PASEO_SUBAGENTS_ADOPT;
    process.env.PASEO_SUBAGENTS_ADOPT = "0";
    const fresh = new TokenRegistry();
    let called = false;
    const rt4 = await startReplyServer({
      registry: fresh,
      deliver: async () => {},
      adopt: () => {
        called = true;
        return false;
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${rt4.port}/mcp?caller=${"d".repeat(48)}`, { method: "POST", body: "" });
      expect(res.status).toBe(401);
      expect(called).toBe(false); // The hatch completely disables the adoption path.
    } finally {
      await rt4.close();
      if (prev === undefined) delete process.env.PASEO_SUBAGENTS_ADOPT;
      else process.env.PASEO_SUBAGENTS_ADOPT = prev;
    }
  });

  // #147: delivery blocks while the parent is mid-turn, so the child must receive
  // tool_result IMMEDIATELY.
  test("slow delivery (parent mid-turn) → quickly acknowledges queued, then still delivers", async () => {
    const slowDeliveries: string[] = [];
    const reg5 = new TokenRegistry();
    const rt5 = await startReplyServer({
      registry: reg5,
      deliverAckMs: 80,
      deliver: async (_p, _t, prompt) => {
        await Bun.sleep(400); // Simulate send() waiting for the parent to end its turn.
        slowDeliveries.push(prompt);
      },
    });
    const tok5 = reg5.mint("parent-slow", "child-slow");
    try {
      const t0 = Date.now();
      const res = await fetch(`http://127.0.0.1:${rt5.port}/mcp?caller=${tok5}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9001, method: "tools/call", params: { name: "reply_to_parent", arguments: { prompt: "SLOW-147" } } }),
      });
      const body = (await res.json()) as any;
      const elapsed = Date.now() - t0;
      expect(res.status).toBe(200);
      expect(elapsed).toBeLessThan(350); // Acknowledgement arrives near ackMs (80ms), WITHOUT waiting 400ms for delivery.
      expect(body.result.isError).toBe(false);
      expect(body.result.content[0].text).toContain("queued");
      expect(slowDeliveries).toHaveLength(0); // Not delivered yet.
      await Bun.sleep(500); // Wait for background delivery to finish.
      expect(slowDeliveries).toEqual(["SLOW-147"]); // The report is not lost.
    } finally {
      await rt5.close();
    }
  });

  // #147: a late failure (after the queued acknowledgement) must be logged and must
  // not become an unhandled rejection.
  test("delivery fails after the acknowledgement deadline → logs server-side while child still gets queued acknowledgement", async () => {
    const reg6 = new TokenRegistry();
    const rt6 = await startReplyServer({
      registry: reg6,
      deliverAckMs: 60,
      deliver: async () => {
        await Bun.sleep(200);
        throw new Error("late boom 147");
      },
    });
    const tok6 = reg6.mint("parent-late", "child-late");
    try {
      const res = await fetch(`http://127.0.0.1:${rt6.port}/mcp?caller=${tok6}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9002, method: "tools/call", params: { name: "reply_to_parent", arguments: { prompt: "LATE-FAIL-147" } } }),
      });
      const body = (await res.json()) as any;
      expect(res.status).toBe(200);
      expect(body.result.isError).toBe(false);
      expect(body.result.content[0].text).toContain("queued");
      await Bun.sleep(300); // Allow the late failure to fire and be caught and logged.
      // Reaching this point means no unhandled rejection crashed the process.
    } finally {
      await rt6.close();
    }
  });
});
