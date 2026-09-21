import { describe, expect, test } from "bun:test";
import { composeInitialPrompt, loadRoleTemplates, parseRoleMd, resolveRole, DEFAULT_ROLE_OVERRIDES, PROVIDER_CATALOGS } from "./roles";

describe("parseRoleMd", () => {
	test("frontmatter + body", () => {
		const raw = `---\nname: demo\ndescription: demo role\ntools: read, grep\n---\n\nYou are demo.`;
		const r = parseRoleMd("demo.md", raw)!;
		expect(r.name).toBe("demo");
		expect(r.description).toBe("demo role");
		expect(r.tools).toEqual(["read", "grep"]);
		expect(r.systemPrompt).toBe("You are demo.");
	});
	test("no frontmatter → null", () => {
		expect(parseRoleMd("x.md", "just text")).toBeNull();
	});
});

describe("loadRoleTemplates (ported from pi-config)", () => {
	test("includes all 5 roles from the current pi ext", () => {
		const roles = loadRoleTemplates();
		for (const name of ["scout", "researcher", "worker", "mermaid-maker", "svg-maker"]) {
			expect(roles.has(name)).toBe(true);
		}
		expect(roles.size).toBeGreaterThanOrEqual(5);
	});
	test("every role has a non-empty systemPrompt", () => {
		for (const r of loadRoleTemplates().values()) {
			expect(r.systemPrompt.length).toBeGreaterThan(0);
		}
	});
});

describe("resolveRole (fail-closed)", () => {
	test("an unknown role lists available roles", () => {
		const r = resolveRole("nope", {});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("scout");
	});
	test("rejects an unknown provider", () => {
		const r = resolveRole("scout", { roles: { scout: { provider: "grok" as never, config: "scout", model: "x" } } });
		expect(r.ok).toBe(false);
	});
	test("rejects a config outside the catalog", () => {
		const r = resolveRole("scout", { roles: { scout: { provider: "codex", config: "yolo", model: "gpt" } } });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("catalog");
	});
	test("a missing model is rejected without automatic selection (new role has no default)", () => {
		const custom = new Map(loadRoleTemplates());
		custom.set("custom-x", { name: "custom-x", description: "", tools: [], systemPrompt: "x" });
		const r = resolveRole("custom-x", { roles: { "custom-x": { provider: "codex", config: "full" } } }, custom);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("model");
	});
	test("default settings → pi/cli-openai entry + model pin", () => {
		const r = resolveRole("scout", {});
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.role.providerEntry).toBe(`pi/cli-openai/${DEFAULT_ROLE_OVERRIDES.scout.model}`);
			expect(r.role.env).toEqual({});
		}
	});
	test("the Claude facet includes the MCP_TOOL_TIMEOUT environment variable", () => {
		const r = resolveRole("worker", { roles: { worker: { provider: "claude", config: "acceptEdits", model: "claude-sonnet-4-5" } } });
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.role.env.MCP_TOOL_TIMEOUT).toBe("300000");
	});
	test("settings override the provider and model for a role (repo wins)", () => {
		const r = resolveRole("worker", { roles: { worker: { provider: "claude", config: "acceptEdits", model: "claude-sonnet-4-5" } } });
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.role.providerEntry).toBe("claude/claude-sonnet-4-5");
	});
});

describe("composeInitialPrompt (user channel — does not modify systemPrompt config)", () => {
	test("prompt + --- + TASK", () => {
		const r = resolveRole("scout", {});
		if (!r.ok) throw new Error("resolve failed");
		const p = composeInitialPrompt(r.role, "map the repo");
		expect(p).toContain("---");
		expect(p).toContain("TASK:\nmap the repo");
		expect(p).toContain(r.role.template.systemPrompt.slice(0, 20));
	});
});

describe("PROVIDER_CATALOGS", () => {
	test("the pi catalog contains all pi ext roles", () => {
		expect(PROVIDER_CATALOGS.pi.configs).toContain("mermaid-maker");
	});
	test("Claude has 3 permission levels", () => {
		expect(PROVIDER_CATALOGS.claude.configs).toEqual(["plan", "acceptEdits", "bypassPermissions"]);
	});
});

// modeMap: config level -> settings.modeId (E2E 18:07 revealed that modeId defaults
// to 'auto'; config 'review' was silently ignored, leaving the Codex child stuck on approval).
describe("modeMap config -> modeId", () => {
	test("codex worker config review -> modeId auto-review", () => {
		const r = resolveRole("worker", {
			roles: { worker: { provider: "codex", config: "review", model: "gpt-5.6-sol" } },
		});
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.role.modeId).toBe("auto-review");
			expect(r.role.providerEntry).toBe("codex/gpt-5.6-sol");
		}
	});
	test("codex full -> full-access; pi role -> modeId undefined", () => {
		const f = resolveRole("worker", { roles: { worker: { provider: "codex", config: "full", model: "m" } } });
		expect(f.ok && f.role.modeId).toBe("full-access");
		const p = resolveRole("scout", {});
		expect(p.ok && p.role.modeId).toBeUndefined();
	});
	test("an unknown config in the new Codex catalog -> fail-closed", () => {
		const r = resolveRole("worker", { roles: { worker: { provider: "codex", config: "read-only", model: "m" } } });
		expect(r.ok).toBe(false);
	});
});
