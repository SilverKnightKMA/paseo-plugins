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

describe("loadRoleTemplates (port từ pi-config)", () => {
	test("đủ 5 role như hiện trạng pi ext", () => {
		const roles = loadRoleTemplates();
		for (const name of ["scout", "researcher", "worker", "mermaid-maker", "svg-maker"]) {
			expect(roles.has(name)).toBe(true);
		}
		expect(roles.size).toBeGreaterThanOrEqual(5);
	});
	test("mỗi role có systemPrompt không rỗng", () => {
		for (const r of loadRoleTemplates().values()) {
			expect(r.systemPrompt.length).toBeGreaterThan(0);
		}
	});
});

describe("resolveRole (fail-closed)", () => {
	test("role lạ → liệt kê role khả dụng", () => {
		const r = resolveRole("nope", {});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("scout");
	});
	test("provider lạ → từ chối", () => {
		const r = resolveRole("scout", { roles: { scout: { provider: "grok" as never, config: "scout", model: "x" } } });
		expect(r.ok).toBe(false);
	});
	test("config ngoài catalog → từ chối", () => {
		const r = resolveRole("scout", { roles: { scout: { provider: "codex", config: "yolo", model: "gpt" } } });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("catalog");
	});
	test("thiếu model → từ chối, không tự chọn (role mới không default)", () => {
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
	test("claude facet → MCP_TOOL_TIMEOUT env đi kèm", () => {
		const r = resolveRole("worker", { roles: { worker: { provider: "claude", config: "acceptEdits", model: "claude-sonnet-4-5" } } });
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.role.env.MCP_TOOL_TIMEOUT).toBe("300000");
	});
	test("settings ghi đè provider + model cho role (repo wins)", () => {
		const r = resolveRole("worker", { roles: { worker: { provider: "claude", config: "acceptEdits", model: "claude-sonnet-4-5" } } });
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.role.providerEntry).toBe("claude/claude-sonnet-4-5");
	});
});

describe("composeInitialPrompt (kênh user — không đụng systemPrompt config)", () => {
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
	test("pi catalog chứa đủ role pi ext", () => {
		expect(PROVIDER_CATALOGS.pi.configs).toContain("mermaid-maker");
	});
	test("claude có 3 mức permission", () => {
		expect(PROVIDER_CATALOGS.claude.configs).toEqual(["plan", "acceptEdits", "bypassPermissions"]);
	});
});
