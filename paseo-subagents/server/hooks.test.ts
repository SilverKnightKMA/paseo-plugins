import { describe, expect, test } from "bun:test";
import { rewriteChildConfig, MODE_ENV, PARENT_ENV, type SubagentReplyRuntime } from "./hooks.js";
import { TokenRegistry } from "./tokens.js";
import type { AgentCreateConfig } from "./hooks.js";

function rt(allowFull = false): SubagentReplyRuntime & { logs: string[] } {
  const logs: string[] = [];
  const r: SubagentReplyRuntime & { logs: string[] } = {
    registry: new TokenRegistry(),
    getPort: () => 45678,
    allowFull,
    log: (m) => logs.push(m),
    logs,
  };
  return r;
}

function rtNoPort(): SubagentReplyRuntime {
  return { registry: new TokenRegistry(), getPort: () => null, allowFull: false, log: () => {} };
}

function baseConfig(overrides: Partial<AgentCreateConfig> = {}): AgentCreateConfig {
  return { provider: "codex/gpt-5.6-luna", cwd: "/tmp", title: "scout-child", ...overrides };
}

describe("rewriteChildConfig", () => {
  test("no PASEO_PARENT_AGENT_ID -> untouched (regular agents keep broad catalog)", () => {
    const input = { config: baseConfig(), env: { FOO: "1" } };
    const out = rewriteChildConfig(input, rt());
    expect(out).toBe(input); // same reference: nothing changed
  });

  test("child with parent env -> mcpServers.paseo replaced by scoped door", () => {
    const r = rt();
    const out = rewriteChildConfig({ config: baseConfig(), env: { [PARENT_ENV]: "parent-1" } }, r);
    const door = (out.config.mcpServers ?? {}).paseo as { type: string; url: string };
    expect(door.type).toBe("http");
    expect(door.url).toContain(`http://127.0.0.1:45678/mcp?caller=`);
    const token = new URL(door.url).searchParams.get("caller");
    expect(r.registry.verify(token)?.parentId).toBe("parent-1");
  });

  test("env vars stripped so the child never sees the parent id as addressable state", () => {
    const out = rewriteChildConfig({ config: baseConfig(), env: { [PARENT_ENV]: "parent-1", OTHER: "keep" } }, rt());
    expect(out.env).not.toHaveProperty(PARENT_ENV);
    expect(out.env).not.toHaveProperty(MODE_ENV);
    expect(out.env).toHaveProperty("OTHER", "keep");
  });

  test("original input not mutated", () => {
    const env = { [PARENT_ENV]: "parent-1" };
    const config = baseConfig();
    rewriteChildConfig({ config, env }, rt());
    expect(config.mcpServers).toBeUndefined();
    expect(env[PARENT_ENV]).toBe("parent-1");
  });

  test("mode knob translated to provider preset", () => {
    const out = rewriteChildConfig(
      { config: baseConfig({ provider: "codex/gpt-5.6-luna" }), env: { [PARENT_ENV]: "p", [MODE_ENV]: "review" } },
      rt(),
    );
    expect(out.config.modeId).toBe("auto-review");
  });

  test("claude translation", () => {
    const out = rewriteChildConfig(
      { config: baseConfig({ provider: "claude/opus" }), env: { [PARENT_ENV]: "p", [MODE_ENV]: "full" } },
      rt(true),
    );
    expect(out.config.modeId).toBe("bypassPermissions");
  });

  test("pi: knob accepted, modeId untouched, warning logged", () => {
    const r = rt();
    const out = rewriteChildConfig(
      { config: baseConfig({ provider: "pi", modeId: undefined }), env: { [PARENT_ENV]: "p", [MODE_ENV]: "auto" } },
      r,
    );
    expect(out.config.modeId).toBeUndefined();
    expect(r.logs.join(" ")).toContain("no selectable modes");
  });

  test("full without opt-in -> refuse spawn (fail-closed)", () => {
    expect(() =>
      rewriteChildConfig({ config: baseConfig(), env: { [PARENT_ENV]: "p", [MODE_ENV]: "full" } }, rt(false))
    ).toThrow(/SUBAGENT_REPLY_ALLOW_FULL/);
  });

  test("full on provider without table -> refused even with opt-in", () => {
    expect(() =>
      rewriteChildConfig(
        { config: baseConfig({ provider: "factory/x" }), env: { [PARENT_ENV]: "p", [MODE_ENV]: "full" } },
        rt(true),
      )
    ).toThrow(/no verified mode table/);
  });

  test("invalid knob value -> refuse spawn", () => {
    expect(() =>
      rewriteChildConfig({ config: baseConfig(), env: { [PARENT_ENV]: "p", [MODE_ENV]: "full-access" } }, rt())
    ).toThrow(/invalid PASEO_CHILD_MODE/);
  });

  test("existing other MCP servers preserved", () => {
    const out = rewriteChildConfig(
      {
        config: baseConfig({ mcpServers: { custom: { type: "stdio", command: "x" } } }),
        env: { [PARENT_ENV]: "p" },
      },
      rt(),
    );
    expect(Object.keys(out.config.mcpServers ?? {}).sort()).toEqual(["custom", "paseo"]);
  });

  test("door not listening yet -> honest error", () => {
    expect(() => rewriteChildConfig({ config: baseConfig(), env: { [PARENT_ENV]: "p" } }, rtNoPort())).toThrow(
      /not listening yet/,
    );
  });

  test("title fallback when missing", () => {
    const r = rt();
    const out = rewriteChildConfig({ config: baseConfig({ title: undefined }), env: { [PARENT_ENV]: "p" } }, r);
    const token = new URL((out.config.mcpServers!.paseo as { url: string }).url).searchParams.get("caller");
    expect(r.registry.verify(token)?.title).toBe("subagent");
  });
});

// ---- registerEnvDoorHook (spec v12 L2 · #157) ----

import { DOOR_ENV, registerEnvDoorHook, type SessionOpenInput } from "./hooks.js";

interface BeforeFn {
  (input: { request: unknown }): unknown;
}

function fakeServer(): { before: (name: string, fn: BeforeFn) => () => void; calls: Array<{ name: string; fn: BeforeFn }> } {
  const calls: Array<{ name: string; fn: BeforeFn }> = [];
  return {
    calls,
    before: (name: string, fn: BeforeFn) => {
      calls.push({ name, fn });
      return () => {};
    },
  };
}

describe("registerEnvDoorHook (L2 #157)", () => {
  const mkRt = rt;
  const server = fakeServer();
  const r = mkRt();
  registerEnvDoorHook(server as unknown as Parameters<typeof registerEnvDoorHook>[0], r, {
    agentsRoot: "/tmp/none",
    envDoorUrlFor: (agentId) => `http://127.0.0.1:43721/mcp?caller=tok-${agentId}`,
  });
  const hook = server.calls.find((c) => c.name === "agent.session_open")!.fn;

  test("a main without a door receives PASEO_SUBAGENTS_DOOR while preserving its existing env", () => {
    const req: SessionOpenInput = { agentId: "main-1", provider: "pi", reason: "refresh", env: { FOO: "1" } };
    const out = hook({ request: req }) as SessionOpenInput;
    expect(out.env!.FOO).toBe("1");
    expect(out.env![DOOR_ENV]).toBe("http://127.0.0.1:43721/mcp?caller=tok-main-1");
  });

  test("a child (PASEO_PARENT_AGENT_ID env) is NOT modified", () => {
    const req: SessionOpenInput = { agentId: "child-1", env: { [PARENT_ENV]: "p" } };
    expect(hook({ request: req })).toBeUndefined();
  });

  test("an existing caller-supplied DOOR_ENV is not overwritten", () => {
    const req: SessionOpenInput = { agentId: "main-2", env: { [DOOR_ENV]: "http://x/mcp?caller=keep" } };
    expect(hook({ request: req })).toBeUndefined();
  });

  test("a missing agentId returns undefined", () => {
    expect(hook({ request: { provider: "pi" } })).toBeUndefined();
  });

  test("envDoorUrlFor returning null (ineligible) leaves the request unchanged", () => {
    const server2 = fakeServer();
    registerEnvDoorHook(server2 as unknown as Parameters<typeof registerEnvDoorHook>[0], r, {
      agentsRoot: "/tmp/none",
      envDoorUrlFor: () => null,
    });
    const h2 = server2.calls[0].fn;
    expect(h2({ request: { agentId: "main-3", env: {} } })).toBeUndefined();
  });
});
