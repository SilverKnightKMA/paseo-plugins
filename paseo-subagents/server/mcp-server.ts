/**
 * Minimal stateless MCP server over StreamableHTTP exposing exactly ONE tool:
 * `reply_to_parent(prompt)`.
 *
 * Identity model: the URL is minted per child (`/mcp?caller=<token>`); a
 * request is accepted only if the token is currently registered. There is no
 * agentId parameter anywhere — the caller cannot address anyone but its own
 * parent, by construction.
 *
 * Unknown callers, unknown tools and delivery failures all answer with honest
 * machine-readable errors (the entwurf honest-reject pattern) so the child
 * model can report the real state instead of guessing.
 */
import http from "node:http";
import type { TokenRegistry } from "./tokens.js";

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

const SERVER_INFO = { name: "paseo-subagents", version: "1.0.0" } as const;

import type { PoolItem } from "./pool";
import { validatePoolArgs } from "./pool";
import { ASK_TOOL, ANSWER_TOOL, validateQuestion, validateAnswer } from "./ask";

const SERVER_INSTRUCTIONS =
  "Scoped reply door: you may ONLY talk to the main agent that spawned you. " +
  "Use reply_to_parent for final reports, findings, questions and blocking decisions.";

const REPLY_TOOL = {
  name: "reply_to_parent",
  description:
    "Send a message to the main agent that spawned you. This is the ONLY channel available: " +
    "no other agent can be contacted. Use it for final reports, key findings, questions, and " +
    "when you need a decision before continuing.",
  inputSchema: {
    type: "object" as const,
    properties: {
      prompt: { type: "string", description: "Message content for the parent agent." },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
};

/** spawn_subagent — chỉ hiện với caller có canSpawn (spec v11 mục 4.3: lọc theo caller). */
export const SPAWN_TOOL = {
  name: "spawn_subagent",
  description:
    "Spawn a subagent with a pinned role (scout/researcher/worker/mermaid-maker/svg-maker). " +
    "DETACH by design: returns {agentId, status:running} immediately — the child reports back " +
    "via [child-report] when done. Provider/model/thinking are pinned in the plugin repo; " +
    "the caller cannot override them (fail-closed on unknown roles).",
  inputSchema: {
    type: "object" as const,
    properties: {
      role: { type: "string", description: "Role id — must exist in the plugin role registry." },
      task: { type: "string", description: "Self-contained task description (the child sees nothing else)." },
      name: { type: "string", description: "Optional display title for the child." },
    },
    required: ["role", "task"],
    additionalProperties: false,
  },
};

/** spawn_pool — fan-out 2-12 children, ≤4 song song (#145 / plan step 10). */
export const POOL_TOOL = {
  name: "spawn_pool",
  description:
    "Spawn 2-12 role-typed subagents in bounded parallel (default 4 at a time). DETACH by design: " +
    "returns {poolId, spawned} immediately. When every child has finished, ONE aggregate " +
    "[pool-report] envelope arrives (each child also reports its own [child-report]). " +
    "Providers/models are pinned per role in the plugin repo (fail-closed on unknown roles).",
  inputSchema: {
    type: "object" as const,
    properties: {
      items: {
        type: "array" as const,
        description: "2-12 independent, self-contained tasks.",
        items: {
          type: "object" as const,
          properties: {
            role: { type: "string" },
            task: { type: "string" },
            name: { type: "string" },
          },
          required: ["role", "task"],
        },
      },
      concurrency: { type: "number", description: "Parallel children at once (1-4, default 4)." },
    },
    required: ["items"],
    additionalProperties: false,
  },
};

export interface SpawnArgs {
  role: string;
  task: string;
  name?: string;
}

/** Caller capability snapshot cần cho dispatch (lấy từ CallerToken). */
export interface CallerCaps {
  canSpawn: boolean;
  depth: number;
  boundAgentId?: string;
}

export type SpawnFn = (caller: CallerCaps, args: SpawnArgs) => Promise<{ agentId: string } | { error: string }>;

export type SpawnPoolFn = (
  caller: CallerCaps,
  args: { items: PoolItem[]; concurrency?: number },
) => Promise<{ poolId: string; spawned: number } | { error: string }>;

/** Con hỏi cha: trả về questionId — KHÔNG block chờ câu trả lời (detach). */
export type AskFn = (
  caller: CallerCaps,
  parentId: string,
  question: string,
) => Promise<{ questionId: string } | { error: string }>;

/** Cha trả lời con: đẩy [parent-answer] vào session con. */
export type AnswerFn = (
  caller: CallerCaps,
  questionId: string,
  answer: string,
) => Promise<{ delivered: true } | { error: string }>;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export type DeliverFn = (parentId: string, title: string, prompt: string) => Promise<void>;

export interface ReplyServerHandle {
  port: number;
  close(): Promise<void>;
}

/** Alias kept for readability at call sites. */
export type McpRuntime = ReplyServerHandle;

export async function startReplyServer(opts: {
  registry: TokenRegistry;
  deliver: DeliverFn;
  host?: string;
}): Promise<ReplyServerHandle> {
  return listenReplyServer(opts);
}

export async function listenReplyServer(opts: {
  registry: TokenRegistry;
  deliver: DeliverFn;
  spawn?: SpawnFn;
  spawnPool?: SpawnPoolFn;
  ask?: AskFn;
  answer?: AnswerFn;
  host?: string;
}): Promise<ReplyServerHandle> {
  const host = opts.host ?? "127.0.0.1";
  const server = http.createServer((req, res) => {
    void handle(req, res, opts).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify(jsonRpcError(null, -32603, `internal error: ${message}`)));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error(`unexpected listen address: ${String(address)}`);
  }

  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(() => resolve());
        server.once("error", reject);
      }),
  };
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, opts: { registry: TokenRegistry; deliver: DeliverFn }): Promise<void> {
  const url = new URL(req.url ?? "/", "http://local");

  if (req.method !== "POST") {
    // Stateless server: no SSE stream, no GET resources.
    res.writeHead(405, { allow: "POST" });
    res.end();
    return;
  }

  const caller = opts.registry.verify(url.searchParams.get("caller"));
  if (!caller) {
    // Honest reject: this token was never minted, or the server restarted.
    res.writeHead(401, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        jsonRpcError(
          null,
          -32001,
          "unknown or expired caller: this endpoint only accepts requests from the single agent whose URL it was minted for; " +
            "if the daemon restarted after you were spawned, your URL is stale",
        ),
      ),
    );
    return;
  }

  const body = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify(jsonRpcError(null, -32700, "parse error: body is not valid JSON")));
    return;
  }

  const messages: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const responses: unknown[] = [];

  for (const message of messages) {
    if (!isJsonRpcRequest(message)) {
      if (looksLikeNotification(message)) continue; // notification: no response
      responses.push(jsonRpcError(null, -32600, "invalid request"));
      continue;
    }
    if (message.id === undefined || message.id === null) continue; // notification: no response
    responses.push(await dispatch(message, { parentId: caller.parentId, title: caller.title, caps: caller, opts }));
  }

  if (responses.length === 0) {
    res.writeHead(202);
    res.end();
    return;
  }
  const isBatch = Array.isArray(parsed);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(isBatch ? responses : responses[0]));
}

interface DispatchCtx {
  parentId: string;
  title: string;
  caps: CallerCaps;
  opts: { registry: TokenRegistry; deliver: DeliverFn; spawn?: SpawnFn; spawnPool?: SpawnPoolFn; ask?: AskFn; answer?: AnswerFn };
}

async function dispatch(message: JsonRpcRequest, ctx: DispatchCtx): Promise<unknown> {
  const id = message.id as string | number;
  switch (message.method) {
    case "initialize": {
      const requested = readProtocolVersion(message.params);
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number])
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      return {
        jsonrpc: "2.0",
        id: id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: SERVER_INSTRUCTIONS,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id: id, result: {} };
    case "tools/list": {
      // Lọc theo caller (spec 4.3): canSpawn=false chỉ thấy reply_to_parent.
      // Con (canSpawn=false): reply + ask_parent. Cha (canSpawn): reply + spawn + pool + answer_child.
      const tools = ctx.caps.canSpawn
        ? [REPLY_TOOL, SPAWN_TOOL, POOL_TOOL, ANSWER_TOOL]
        : [REPLY_TOOL, ASK_TOOL];
      return { jsonrpc: "2.0", id: id, result: { tools } };
    }
    case "tools/call": {
      const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (params.name === REPLY_TOOL.name) {
        const args = (params.arguments ?? {}) as { prompt?: unknown };
        if (typeof args.prompt !== "string" || args.prompt.length === 0) {
          return jsonRpcError(id, -32900, "invalid arguments: 'prompt' (non-empty string) is required");
        }
        try {
          await ctx.opts.deliver(ctx.parentId, ctx.title, args.prompt);
          return {
            jsonrpc: "2.0",
            id: id,
            result: { content: [{ type: "text", text: `delivered to parent agent` }], isError: false },
          };
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return {
            jsonrpc: "2.0",
            id: id,
            result: {
              content: [{ type: "text", text: `delivery failed: ${reason}` }],
              isError: true,
            },
          };
        }
      }
      if (params.name === SPAWN_TOOL.name) {
        const spawn = ctx.opts.spawn;
        if (!spawn) {
          return jsonRpcError(id, -32601, `spawn_subagent is not enabled on this door`);
        }
        if (!ctx.caps.canSpawn) {
          return jsonRpcError(id, -32901, `spawn_subagent refused: this caller's role cannot spawn (canSpawn=false, spec mục 6)`);
        }
        const args = (params.arguments ?? {}) as Partial<SpawnArgs>;
        if (typeof args.role !== "string" || typeof args.task !== "string" || args.task.length === 0) {
          return jsonRpcError(id, -32900, "invalid arguments: 'role' and 'task' (non-empty strings) are required");
        }
        try {
          const result = await spawn(ctx.caps, { role: args.role, task: args.task, name: typeof args.name === "string" ? args.name : undefined });
          if ("error" in result) {
            return { jsonrpc: "2.0", id: id, result: { content: [{ type: "text", text: `spawn failed: ${result.error}` }], isError: true } };
          }
          return {
            jsonrpc: "2.0",
            id: id,
            result: {
              content: [{ type: "text", text: JSON.stringify({ agentId: result.agentId, status: "running", note: "kết quả sẽ tới qua envelope [child-report] khi child xong (detach — spec v11 mục 3)" }) }],
              isError: false,
            },
          };
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return { jsonrpc: "2.0", id: id, result: { content: [{ type: "text", text: `spawn failed: ${reason}` }], isError: true } };
        }
      }
      if (params.name === POOL_TOOL.name) {
        const spawnPool = ctx.opts.spawnPool;
        if (!spawnPool) return jsonRpcError(id, -32601, `spawn_pool is not enabled on this door`);
        if (!ctx.caps.canSpawn) {
          return jsonRpcError(id, -32901, `spawn_pool refused: this caller's role cannot spawn (canSpawn=false, spec mục 6)`);
        }
        const args = (params.arguments ?? {}) as { items?: unknown; concurrency?: unknown };
        const v = validatePoolArgs(args.items, args.concurrency);
        if (!v.ok) return jsonRpcError(id, -32900, v.error);
        try {
          const result = await spawnPool(ctx.caps, { items: v.pool.items, concurrency: v.pool.concurrency });
          if ("error" in result) {
            return { jsonrpc: "2.0", id: id, result: { content: [{ type: "text", text: `spawn_pool failed: ${result.error}` }], isError: true } };
          }
          return {
            jsonrpc: "2.0",
            id: id,
            result: {
              content: [{
                type: "text",
                text: JSON.stringify({ poolId: result.poolId, spawned: result.spawned, status: "running", note: "MỘT envelope [pool-report] aggregate sẽ tới khi mọi child terminal; từng con tự gửi [child-report] riêng (detach — spec v11 mục 3)" }),
              }],
              isError: false,
            },
          };
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return { jsonrpc: "2.0", id: id, result: { content: [{ type: "text", text: `spawn_pool failed: ${reason}` }], isError: true } };
        }
      }
      if (params.name === ASK_TOOL.name) {
        const ask = ctx.opts.ask;
        if (!ask) return jsonRpcError(id, -32601, `ask_parent is not enabled on this door`);
        const v = validateQuestion(((params.arguments ?? {}) as { question?: unknown }).question);
        if (!v.ok) return jsonRpcError(id, -32900, v.error);
        try {
          const r = await ask(ctx.caps, ctx.parentId, v.question);
          if ("error" in r) {
            return { jsonrpc: "2.0", id: id, result: { content: [{ type: "text", text: `ask_parent failed: ${r.error}` }], isError: true } };
          }
          return {
            jsonrpc: "2.0", id: id,
            result: { content: [{ type: "text", text: `câu hỏi đã tới parent (questionId ${r.questionId}) — KHÔNG đợi: [parent-answer] sẽ tới như tin nhắn mới đánh thức con. Kết thúc lượt hoặc làm tiếp việc khác.` }], isError: false },
          };
        } catch (err) {
          return { jsonrpc: "2.0", id: id, result: { content: [{ type: "text", text: `ask_parent failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true } };
        }
      }
      if (params.name === ANSWER_TOOL.name) {
        const answer = ctx.opts.answer;
        if (!answer) return jsonRpcError(id, -32601, `answer_child is not enabled on this door`);
        if (!ctx.caps.canSpawn) return jsonRpcError(id, -32901, `answer_child refused: chỉ parent (canSpawn=true) được trả lời con`);
        const a = (params.arguments ?? {}) as { questionId?: unknown; answer?: unknown };
        const v = validateAnswer(a.questionId, a.answer);
        if (!v.ok) return jsonRpcError(id, -32900, v.error);
        try {
          const r = await answer(ctx.caps, v.questionId, v.answer);
          if ("error" in r) {
            return { jsonrpc: "2.0", id: id, result: { content: [{ type: "text", text: `answer_child failed: ${r.error}` }], isError: true } };
          }
          return { jsonrpc: "2.0", id: id, result: { content: [{ type: "text", text: `[parent-answer] đã tới con` }], isError: false } };
        } catch (err) {
          return { jsonrpc: "2.0", id: id, result: { content: [{ type: "text", text: `answer_child failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true } };
        }
      }
      return jsonRpcError(id, -32602, `unknown tool '${String(params.name)}': this endpoint exposes ${ctx.caps.canSpawn ? "reply_to_parent, spawn_subagent, spawn_pool, answer_child" : "reply_to_parent, ask_parent"}`);
    }
    default:
      return jsonRpcError(id, -32601, `method not found: ${message.method}`);
  }
}

function readProtocolVersion(params: unknown): string {
  if (params && typeof params === "object" && "protocolVersion" in params) {
    const v = (params as { protocolVersion?: unknown }).protocolVersion;
    if (typeof v === "string") return v;
  }
  return SUPPORTED_PROTOCOL_VERSIONS[0];
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return (
    typeof value === "object" && value !== null && "jsonrpc" in value && "method" in value &&
    typeof (value as JsonRpcRequest).method === "string"
  );
}

function looksLikeNotification(value: unknown): boolean {
  return typeof value === "object" && value !== null && "method" in value && !("id" in value);
}

function jsonRpcError(id: string | number | null, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
