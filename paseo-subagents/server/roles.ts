/**
 * paseo-subagents — role templates (port từ pi-config extensions/subagent-types).
 *
 * Spec v11 (learn/spec-paseo-subagent-plugin-2026-09-20.md):
 * - Role template cố định trong repo (roles/*.md frontmatter + body prompt).
 * - Plugin là source of truth; settings chỉ override tham số chạy
 *   {provider, config, model, thinking} — MỖI ROLE MỘT PROVIDER.
 * - Provider facets builtin: đổi provider kéo theo cả bộ (mode/permission/env).
 * - Prompt role đi qua initialPrompt (user prompt) — KHÔNG set systemPrompt config.
 * - Fail-closed: role lạ / provider thiếu / model thiếu → lỗi rõ ràng, không spawn.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { BUILTIN_ROLE_MD } from "./role-md.generated.js";

export interface RoleTemplate {
	name: string;
	description: string;
	tools: string[]; // pi role allowlist (chỉ có ý nghĩa khi provider = pi)
	systemPrompt: string; // nhét vào initialPrompt, KHÔNG vào systemPrompt config
}

/** Ghi đè tham số chạy cho một role (settings file trong repo). */
export interface RoleOverride {
	provider: string; // tên gọn: "pi" | "codex" | "claude"
	config: string; // mức config trong catalog của provider
	model?: string;
	thinking?: string;
}

export interface PluginSettings {
	roles?: Record<string, Partial<RoleOverride>>;
	poolConcurrency?: number;
	syncProfilesOnLoad?: boolean;
	rolePromptChannel?: "user" | "append" | "replace"; // mặc định "user"
}

/** Catalog mức config builtin theo provider (spec mục Catalog nguồn). */
/**
 * modeMap: config level → settings.modeId của daemon.
 * Codex modeIds thật (codex-app-server-agent.js): auto | auto-review | full-access.
 * Claude: plan | acceptEdits | bypassPermissions (best-effort, tên mode bảng provider).
 * Pi: không cần modeId — role allowlist do ext subagent-types giữ (label subagent.role).
 */
export const PROVIDER_CATALOGS: Record<string, {
	configs: string[];
	defaultProviderEntry: string;
	env?: Record<string, string>;
	modeMap?: Record<string, string>;
}> = {
	pi: {
		configs: ["scout", "researcher", "worker", "mermaid-maker", "svg-maker"],
		defaultProviderEntry: "pi/cli-openai", // plugin tự map tên gọn → entry thật
	},
	codex: {
		configs: ["auto", "review", "full"],
		defaultProviderEntry: "codex",
		modeMap: { auto: "auto", review: "auto-review", full: "full-access" },
	},
	claude: {
		configs: ["plan", "acceptEdits", "bypassPermissions"],
		defaultProviderEntry: "claude",
		modeMap: { plan: "plan", acceptEdits: "acceptEdits", bypassPermissions: "bypassPermissions" },
		// G4 live: claude default HTTP MCP tool-call ~45s — nâng trần cho spawn/pool/ask
		env: { MCP_TOOL_TIMEOUT: "300000" },
	},
};

/** Parse một file role markdown (frontmatter + body) — parity parseRoleMd pi ext. */
export function parseRoleMd(filename: string, raw: string): RoleTemplate | null {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return null;
	const meta: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
		if (kv) meta[kv[1].toLowerCase()] = kv[2].trim();
	}
	const name = meta.name || filename.replace(/\.md$/i, "");
	if (!name) return null;
	const body = match[2].trim();
	if (!body && !meta.tools) return null;
	return {
		name,
		description: meta.description ?? "",
		tools: (meta.tools ?? "")
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean),
		systemPrompt: body,
	};
}

/** Load toàn bộ role template — mặc định từ BUILTIN nhúng trong code (spec v5: template cố định, không phụ thuộc filesystem runtime). */
export function loadRoleTemplates(): Map<string, RoleTemplate> {
	const roles = new Map<string, RoleTemplate>();
	for (const [name, md] of Object.entries(BUILTIN_ROLE_MD)) {
		const role = parseRoleMd(`${name}.md`, md);
		if (role) roles.set(role.name, role);
	}
	return roles;
}

/** Biến thể cho test/dev: đọc từ thư mục roles/ (vd repo đang phát triển). */
export function loadRoleTemplatesFromDir(rolesDir: string): Map<string, RoleTemplate> {
	const roles = new Map<string, RoleTemplate>();
	if (!existsSync(rolesDir)) return roles;
	for (const file of readdirSync(rolesDir)) {
		if (!file.toLowerCase().endsWith(".md")) continue;
		try {
			const role = parseRoleMd(file, readFileSync(join(rolesDir, file), "utf-8"));
			if (role) roles.set(role.name, role);
		} catch {
			// skip unreadable
		}
	}
	return roles;
}

export interface ResolvedRole {
	template: RoleTemplate;
	providerEntry: string; // entry thật của daemon, vd "pi/cli-openai"
	config: string;
	model: string | undefined;
	thinking: string | undefined;
	env: Record<string, string>; // facet env đi kèm provider
	modeId: string | undefined; // config level → modeId daemon (pi: undefined)
	channel: "user" | "append" | "replace";
}

/** Mặc định tham số chạy cho từng role (spec settings ví dụ — repo wins). */
export const DEFAULT_ROLE_OVERRIDES: Record<string, RoleOverride> = {
	scout: { provider: "pi", config: "scout", model: "fci/deepseek-v4-flash", thinking: "low" },
	researcher: { provider: "pi", config: "researcher", model: "fci/deepseek-v4-flash", thinking: "medium" },
	worker: { provider: "pi", config: "worker", model: "fci/deepseek-v4-flash", thinking: "medium" },
	"mermaid-maker": { provider: "pi", config: "mermaid-maker", model: "fci/deepseek-v4-flash", thinking: "low" },
	"svg-maker": { provider: "pi", config: "svg-maker", model: "fci/deepseek-v4-flash", thinking: "low" },
};

/**
 * Resolve role → cấu hình spawn. Fail-closed trả { error } thay vì đoán bừa.
 */
export function resolveRole(
	roleName: string,
	settings: PluginSettings,
	templates = loadRoleTemplates(),
): { ok: true; role: ResolvedRole } | { ok: false; error: string } {
	const template = templates.get(roleName);
	if (!template) {
		const available = [...templates.keys()].sort().join(", ");
		return { ok: false, error: `unknown role '${roleName}' — available roles: ${available}` };
	}
	const override = { ...DEFAULT_ROLE_OVERRIDES[roleName], ...settings.roles?.[roleName] };
	const provider = override.provider;
	const facet = PROVIDER_CATALOGS[provider];
	if (!facet) {
		return { ok: false, error: `role '${roleName}': unknown provider '${provider}' — pick one of ${Object.keys(PROVIDER_CATALOGS).join(", ")}` };
	}
	if (!override.config || !facet.configs.includes(override.config)) {
		return { ok: false, error: `role '${roleName}': config '${override.config ?? "(missing)"}' not in ${provider} catalog [${facet.configs.join(", ")}]` };
	}
	if (!override.model) {
		return { ok: false, error: `role '${roleName}': no model pinned (settings phải có model cho provider ${provider}) — fail-closed, không tự chọn` };
	}
	return {
		ok: true,
		role: {
			template,
			providerEntry: `${facet.defaultProviderEntry}/${override.model}`,
			config: override.config,
			model: override.model,
			thinking: override.thinking,
			env: { ...(facet.env ?? {}) },
			modeId: facet.modeMap?.[override.config],
			channel: settings.rolePromptChannel ?? "user",
		},
	};
}

/** initialPrompt = role prompt + --- + TASK (kênh "user" — spec v11). */
export function composeInitialPrompt(role: ResolvedRole, task: string): string {
	return [role.template.systemPrompt, "---", `TASK:\n${task}`].filter(Boolean).join("\n\n");
}
