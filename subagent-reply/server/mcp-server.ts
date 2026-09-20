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

const SERVER_INFO = { name: "paseo-subagent-reply", version: "1.0.0" } as const;

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
    responses.push(await dispatch(message, caller.parentId, caller.title, opts.deliver, message.id));
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

async function dispatch(
  message: JsonRpcRequest,
  parentId: string,
  title: string,
  deliver: DeliverFn,
  id: string | number,
): Promise<unknown> {
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
    case "tools/list":
      return { jsonrpc: "2.0", id: id, result: { tools: [REPLY_TOOL] } };
    case "tools/call": {
      const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (params.name !== REPLY_TOOL.name) {
        return jsonRpcError(id, -32602, `unknown tool '${String(params.name)}': this endpoint exposes only reply_to_parent`);
      }
      const args = (params.arguments ?? {}) as { prompt?: unknown };
      if (typeof args.prompt !== "string" || args.prompt.length === 0) {
        return jsonRpcError(id, -32900, "invalid arguments: 'prompt' (non-empty string) is required");
      }
      try {
        await deliver(parentId, title, args.prompt);
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
