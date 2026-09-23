import { composeInitialPrompt, loadRoleTemplates, parseRoleMd, resolveRole, doorToolPolicy, DEFAULT_ROLE_OVERRIDES, PROVIDER_CATALOGS } from "./roles";
import { BUILTIN_ROLE_MD } from "./role-md.generated.js";
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
	test("Claude has 5 permission levels (#273 matrix — full daemon DEFAULT_MODES)", () => {
		expect(PROVIDER_CATALOGS.claude.configs).toEqual(["plan", "default", "acceptEdits", "auto", "bypassPermissions"]);
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
	test("codex read-only maps to the hidden read-only preset (#273 matrix)", () => {
		const r = resolveRole("worker", { roles: { worker: { provider: "codex", config: "read-only", model: "m" } } });
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.role.modeId).toBe("read-only");
	});
	test("an unknown config in the Codex catalog -> fail-closed", () => {
		const r = resolveRole("worker", { roles: { worker: { provider: "codex", config: "yolo", model: "m" } } });
		expect(r.ok).toBe(false);
	});
});

describe("#225 doorToolPolicy (provider-true reply channel)", () => {
	test("pi gets NO toolPolicy — the daemon rejects it for pi outright", () => {
		expect(doorToolPolicy("pi", "paseo")).toBeUndefined();
	});

	test("claude/codex pre-approve exactly the two door tools on the child's MCP server key", () => {
		for (const provider of ["claude", "codex"] as const) {
			const policy = doorToolPolicy(provider, "paseo");
			expect(policy?.preapproved).toEqual([
				{ kind: "mcp", server: "paseo", tool: "reply_to_parent" },
				{ kind: "mcp", server: "paseo", tool: "ask_parent" },
			]);
		}
	});
});

describe("#225 role templates tell the provider truth", () => {
	test("every builtin template says reply_to_parent and none says message_main", () => {
		for (const [name, md] of Object.entries(BUILTIN_ROLE_MD)) {
			expect(md).toContain("reply_to_parent");
			expect(md).not.toContain("message_main");
		}
	});

	test("every builtin template carries the end-with-text fallback", () => {
		for (const [name, md] of Object.entries(BUILTIN_ROLE_MD)) {
			expect(md).toContain("the system captures it");
		}
	});
});

describe("#226 resolved role carries the short provider", () => {
	test("resolveRole exposes provider for the toolPolicy decision", () => {
		const r = resolveRole("codex-worker", {});
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.role.provider).toBe("codex");
		const s = resolveRole("scout", {});
		expect(s.ok).toBe(true);
		if (s.ok) expect(s.role.provider).toBe("pi");
	});
});
