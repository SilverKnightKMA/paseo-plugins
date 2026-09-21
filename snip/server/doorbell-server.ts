/**
 * doorbell-server (#39 Phase 1) — plugin side of the engine→plugin bell.
 *
 * DISK IS TRUTH: the engine writes the file, then pokes every socket under
 * ~/.paseo/plugin-data/bridges/. This server listens on
 * bridges/<pluginId>.sock and, for bell kinds it OWNS, appends an invisible
 * timeline item to the agent whose runtimeInfo.sessionId matches — the
 * daemon then broadcasts agent_stream, which wakes every subscribed plugin
 * client (use-live.ts) to refetch the file. No data crosses the socket.
 *
 * Ownership rule: exactly ONE plugin appends per bell kind, so a bell
 * produces exactly one timeline item:
 *   om-status  → ["om-status"]
 *   task       → ["task-status", "task-control"]
 *   snip       → ["snip-control"]
 *   memory     → ["facts-status"]
 * Panels in OTHER plugins (om-panel etc.) wake transitively via their own
 * agent-timeline subscription — they must NOT open a socket.
 *
 * The appended item uses kind "doorbell" with NO registered renderer, so it
 * is invisible in the timeline UI; it exists purely as a wake signal.
 *
 * Never-throws contract: socket errors are logged and swallowed — a bell
 * must never break plugin load or the RPC surface.
 */

import { createServer, type Server, type Socket } from "node:net";
import { mkdirSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Structural slice of PaseoApi this module needs — a LOCAL type so plugin
 *  builds never depend on @getpaseo/client resolution (install esbuild
 *  boundary: type-imports still go through the resolver). */
export interface DoorbellPaseoApi {
	agents: {
		list: () => Promise<unknown>;
		ref: (id: string) => { timeline: { append: (item: DoorbellItem) => Promise<unknown> } };
	};
}

export interface DoorbellPokeLine {
	v: number;
	sessionId: string;
	kind: string;
	file: string;
	ts: string;
}

export interface DoorbellAgentBrief {
	id: string;
	sessionId: string | null;
}

export interface DoorbellDeps {
	/** Bridges dir override (tests). Default ~/.paseo/plugin-data/bridges. */
	dir?: string;
	/** Resolve agents (default: paseo.agents.list() → runtimeInfo.sessionId). */
	listAgents?: () => Promise<DoorbellAgentBrief[]>;
	/** Append a timeline item (default: paseo.agents.ref(id).timeline.append). */
	append?: (agentId: string, item: DoorbellItem) => Promise<unknown>;
	log?: (msg: string) => void;
}

export interface DoorbellItem {
	type: "plugin";
	id: string;
	kind: "doorbell";
	version: 1;
	data: { bell: string; file: string; ts: string };
}

export type DoorbellOutcome = "handled" | "foreign" | "invalid" | "no-agent" | "error";

const SESSION_CACHE_TTL_MS = 30_000;

export function createDoorbellServer(pluginId: string, owns: readonly string[], deps: DoorbellDeps = {}) {
	const log = deps.log ?? (() => {});
	let api: DoorbellPaseoApi | null = null;
	let server: Server | null = null;
	let sockPath = "";
	/** sessionId → { agentId, at } cache (agents.list() is not free). */
	const sessionCache = new Map<string, { agentId: string; at: number }>();

	function socketDir(): string {
		return deps.dir ?? join(homedir(), ".paseo", "plugin-data", "bridges");
	}

	function listAgents(): Promise<DoorbellAgentBrief[]> {
		if (deps.listAgents) return deps.listAgents();
		if (!api?.agents) return Promise.resolve([]);
		return (api.agents.list() as Promise<{ entries?: unknown[] }>).then((raw) => {
			// daemon entries are {agent: {...}} wrappers (session-filter.ts #68:
			// a flat-shape unwrap yields 0 agents — same trap as the plan port).
			const entries = Array.isArray(raw?.entries) ? raw.entries : [];
			const out: DoorbellAgentBrief[] = [];
			for (const e of entries) {
				const agent = (e as { agent?: { id?: string; runtimeInfo?: { sessionId?: string | null } } }).agent;
				if (agent?.id) out.push({ id: agent.id, sessionId: agent.runtimeInfo?.sessionId ?? null });
			}
			return out;
		});
	}

	function appendItem(agentId: string, item: DoorbellItem): Promise<unknown> {
		if (deps.append) return deps.append(agentId, item);
		if (!api) throw new Error("doorbell: no paseo api captured yet");
		return api.agents.ref(agentId).timeline.append(item);
	}

	/** Capture the daemon client — called from RPC handlers and lifecycle hooks. */
	function setPaseo(next: DoorbellPaseoApi | null): void {
		if (next) api = next;
	}

	async function resolveAgentId(sessionId: string): Promise<string | null> {
		const cached = sessionCache.get(sessionId);
		if (cached && Date.now() - cached.at < SESSION_CACHE_TTL_MS) return cached.agentId;
		try {
			const agents = await listAgents();
			for (const a of agents) {
				if (a.sessionId) sessionCache.set(a.sessionId, { agentId: a.id, at: Date.now() });
			}
			return sessionCache.get(sessionId)?.agentId ?? null;
		} catch (err) {
			log(`doorbell: agents.list failed: ${String(err)}`);
			return null;
		}
	}

	/** Process one bell line. Pure-ish core (exported for tests). */
	async function handleLine(line: string): Promise<DoorbellOutcome> {
		let poke: DoorbellPokeLine;
		try {
			poke = JSON.parse(line) as DoorbellPokeLine;
		} catch {
			return "invalid";
		}
		if (!poke || poke.v !== 1 || typeof poke.kind !== "string" || typeof poke.sessionId !== "string") {
			return "invalid";
		}
		if (!owns.includes(poke.kind)) return "foreign";
		const agentId = await resolveAgentId(poke.sessionId);
		if (!agentId) {
			log(`doorbell: no agent for session ${poke.sessionId}`);
			return "no-agent";
		}
		const item: DoorbellItem = {
			type: "plugin",
			id: `doorbell-${poke.ts}-${Math.random().toString(36).slice(2, 8)}`,
			kind: "doorbell",
			version: 1,
			data: { bell: poke.kind, file: poke.file ?? "", ts: poke.ts ?? "" },
		};
		try {
			await appendItem(agentId, item);
			return "handled";
		} catch (err) {
			log(`doorbell: append failed: ${String(err)}`);
			return "error";
		}
	}

	/** Open the bridge socket. No-op when this plugin owns no bell kinds. */
	function start(): void {
		if (owns.length === 0) return;
		try {
			const dir = socketDir();
			sockPath = join(dir, `${pluginId}.sock`);
			mkdirSync(dir, { recursive: true });
			try {
				unlinkSync(sockPath); // stale socket from a previous daemon run
			} catch {
				// not there — fine
			}
			server = createServer((conn: Socket) => {
				let buf = "";
				conn.on("data", (d) => {
					buf += d.toString("utf8");
				});
				conn.on("close", () => {
					for (const l of buf.split("\n")) {
						const line = l.trim();
						if (!line) continue;
						void handleLine(line).catch(() => {});
					}
				});
				conn.on("error", () => {
					/* bell only — ignore */
				});
			});
			server.on("error", (err) => {
				// A bell must never break the plugin: log and disable.
				log(`doorbell: socket error: ${String(err)}`);
				server = null;
			});
			server.listen(sockPath, () => log(`doorbell: listening ${sockPath} (owns: ${owns.join(",")})`));
		} catch (err) {
			log(`doorbell: start failed: ${String(err)}`);
			server = null;
		}
	}

	async function stop(): Promise<void> {
		const s = server;
		server = null;
		if (!s) return;
		await new Promise<void>((resolve) => s.close(() => resolve()));
		try {
			rmSync(sockPath, { force: true });
		} catch {
			// best effort
		}
	}

	return { handleLine, start, stop, setPaseo };
}

export type DoorbellServer = ReturnType<typeof createDoorbellServer>;

/**
 * safeOn (#lesson 2026-09-21): registering an unknown event name can kill
 * the whole plugin load. Wrap every lifecycle registration and never throw.
 */
export function safeOnDoorbellCapture(
	server: { on: (name: never, handler: (event: unknown, context: { paseo: DoorbellPaseoApi }) => void) => () => void },
	bell: DoorbellServer,
	events: readonly string[] = ["agent.turn_started", "agent.turn_ended", "agent.created"],
	log: (msg: string) => void = () => {},
): void {
	for (const name of events) {
		try {
			server.on(name as never, (_event, context) => bell.setPaseo(context.paseo));
		} catch (err) {
			log(`doorbell: safeOn ${name} failed: ${String(err)}`);
		}
	}
}
