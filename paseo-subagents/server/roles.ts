/**
 * paseo-subagents — role templates (ported from pi-config extensions/subagent-types).
 *
 * Spec v11 (learn/spec-paseo-subagent-plugin-2026-09-20.md):
 * - Role templates are fixed in the repo (roles/*.md frontmatter + body prompt).
 * - The plugin is the source of truth; settings override only runtime parameters
 *   {provider, config, model, thinking} — ONE PROVIDER PER ROLE.
 * - Built-in provider facets: changing providers changes the entire set (mode/permission/env).
 * - The role prompt goes through initialPrompt (user prompt) — do NOT set systemPrompt config.
 * - Fail closed: unknown role / missing provider / missing model → explicit error, no spawn.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { BUILTIN_ROLE_MD } from "./role-md.generated.js";

export interface RoleTemplate {
	name: string;
	description: string;
	tools: string[]; // Pi role allowlist (meaningful only when provider = pi).
	systemPrompt: string; // Added to initialPrompt, NOT to systemPrompt config.
}

/** Runtime parameter overrides for a role (settings file in the repo). */
export interface RoleOverride {
	provider: string; // Short name: "pi" | "codex" | "claude".
	config: string; // Config level in the provider catalog.
	model?: string;
	thinking?: string;
}

export interface PluginSettings {
	roles?: Record<string, Partial<RoleOverride>>;
	poolConcurrency?: number;
	syncProfilesOnLoad?: boolean;
	rolePromptChannel?: "user" | "append" | "replace"; // Defaults to "user".
	/** #230 tier 1: remind the parent once per settled child after this many idle minutes (0 = off). */
	remindAfterMinutes?: number;
	/** #230 tier 2: plugin force-archives unarchived children after this many days (0 = off, max 90). */
	archiveAfterDays?: number;
}

/** Built-in config-level catalog by provider (spec Source Catalog section). */
/**
 * modeMap: config level → daemon settings.modeId.
 * Actual Codex modeIds (codex-app-server-agent.js): auto | auto-review | full-access.
 * Claude: plan | acceptEdits | bypassPermissions (best effort, provider-table mode names).
 * Pi: no modeId needed — ext subagent-types owns the role allowlist (subagent.role label).
 */
export const PROVIDER_CATALOGS: Record<string, {
	configs: string[];
	defaultProviderEntry: string;
	env?: Record<string, string>;
	modeMap?: Record<string, string>;
}> = {
	pi: {
		configs: ["scout", "researcher", "worker", "mermaid-maker", "svg-maker"],
		defaultProviderEntry: "pi/cli-openai", // Plugin maps the short name to the actual entry.
	},
	codex: {
		configs: ["auto", "review", "full", "read-only"], // #273 matrix: read-only = hidden preset in daemon MODE_PRESETS
		defaultProviderEntry: "codex",
		modeMap: { auto: "auto", review: "auto-review", full: "full-access", "read-only": "read-only" },
	},
	claude: {
		configs: ["plan", "default", "acceptEdits", "auto", "bypassPermissions"], // #273 matrix: full daemon DEFAULT_MODES (5) — was 3 best-effort
		defaultProviderEntry: "claude",
		modeMap: { plan: "plan", default: "default", acceptEdits: "acceptEdits", auto: "auto", bypassPermissions: "bypassPermissions" },
		// G4 live: Claude's default HTTP MCP tool call is ~45s — raise the limit for spawn/pool/ask.
		env: { MCP_TOOL_TIMEOUT: "300000" },
	},
};

/** Parse a role markdown file (frontmatter + body) — matches pi ext parseRoleMd. */
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

/** Load all role templates — default to the BUILTIN embedded in code (spec v5: fixed templates, no runtime filesystem dependency). */
export function loadRoleTemplates(): Map<string, RoleTemplate> {
	const roles = new Map<string, RoleTemplate>();
	for (const [name, md] of Object.entries(BUILTIN_ROLE_MD)) {
		const role = parseRoleMd(`${name}.md`, md);
		if (role) roles.set(role.name, role);
	}
	return roles;
}

/** Test/development variant: read from the roles/ directory (for example, while developing the repo). */
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
	providerEntry: string; // Actual daemon entry, for example "pi/cli-openai".
	provider: string; // Short name: "pi" | "codex" | "claude" (same provider family as the catalog key).
	config: string;
	model: string | undefined;
	thinking: string | undefined;
	env: Record<string, string>; // Facet environment variables bundled with the provider.
	modeId: string | undefined; // Config level → daemon modeId (pi: undefined).
	channel: "user" | "append" | "replace";
}

/** Default runtime parameters for each role (example spec settings — repo wins). */
export const DEFAULT_ROLE_OVERRIDES: Record<string, RoleOverride> = {
	// F11 2026-09-22: defaults mirror settings.json (repo wins; these are fail-safe only).
	// Pi roles: model+thinking match pi-config agents/*.md @508dd96 (the originals).
	scout: { provider: "pi", config: "scout", model: "mmcp/MiniMax-M3", thinking: "high" },
	researcher: { provider: "pi", config: "researcher", model: "zaicp/glm-5.3-flash", thinking: "high" },
	worker: { provider: "pi", config: "worker", model: "zaicp/glm-5.3", thinking: "high" },
	"mermaid-maker": { provider: "pi", config: "mermaid-maker", model: "zaicp/glm-5.3-flash", thinking: "max" },
	"svg-maker": { provider: "pi", config: "svg-maker", model: "zaicp/glm-5.3-flash", thinking: "max" },
	// F11 new roles (user-pinned 2026-09-22): claude=fci/deepseek-v4-flash, codex=gpt-5.6-luna
	// (verified live: codex exec --model gpt-5.6-luna → LUNA-OK), thinking medium cả hai.
	"claude-worker": { provider: "claude", config: "acceptEdits", model: "fci/deepseek-v4-flash", thinking: "medium" },
	"codex-worker": { provider: "codex", config: "full", model: "gpt-5.6-luna", thinking: "medium" },
};

/**
 * Resolve role → spawn config. Fail closed with { error } instead of guessing.
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
		return { ok: false, error: `role '${roleName}': no model pinned (settings must specify a model for provider ${provider}) — fail-closed, no automatic selection` };
	}
	return {
		ok: true,
		role: {
			template,
			providerEntry: `${facet.defaultProviderEntry}/${override.model}`,
			provider,
			config: override.config,
			model: override.model,
			thinking: override.thinking,
			env: { ...(facet.env ?? {}) },
			modeId: facet.modeMap?.[override.config],
			channel: settings.rolePromptChannel ?? "user",
		},
	};
}

/** initialPrompt = role prompt + --- + TASK ("user" channel — spec v11). */
export function composeInitialPrompt(role: ResolvedRole, task: string): string {
	return [role.template.systemPrompt, "---", `TASK:\n${task}`].filter(Boolean).join("\n\n");
}

/**
 * #225: pre-approve the door MCP tools on the child's create config.
 *
 * Evidence (F11 smoke 2026-09-22): the claude child's mcp__paseo__reply_to_parent
 * call hung 71 minutes in acceptEdits — the provider harness permission-gates MCP
 * tools and a headless child has nobody to approve. The daemon has a first-class
 * mechanism for exactly this: config.toolPolicy.preapproved — claude maps it to
 * allowedTools (`mcp__paseo__reply_to_parent`), codex to `enabled_tools` +
 * approval_mode "approve".
 *
 * pi does NOT support toolPolicy (agent-manager throws "Provider 'pi' cannot
 * preapprove exact MCP tools") — pi children reach the door through the native
 * extension tool, which is already ungated, so pi returns undefined.
 */
export function doorToolPolicy(
	provider: string,
	serverKey: string,
): { preapproved: { kind: "mcp"; server: string; tool: string }[] } | undefined {
	if (provider === "pi") return undefined;
	return {
		preapproved: [
			{ kind: "mcp", server: serverKey, tool: "reply_to_parent" },
			{ kind: "mcp", server: serverKey, tool: "ask_parent" },
		],
	};
}
