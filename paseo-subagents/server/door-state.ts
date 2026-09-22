/**
 * F10 (#219): cross-process door endpoint + grant persistence.
 *
 * The reply-door listener binds an ephemeral port on every plugin (re)start, so
 * a door URL held by a RUNNING session (env var / child record) goes stale the
 * moment the plugin process is replaced. Two files under
 * ~/.paseo/plugin-data/paseo-subagents/ close that gap:
 *
 *   door-state.json — { port, updatedAt } the CURRENT listener port. The engine
 *     (pi-config door-tool.ts, v1.4.131+) reads this on network failure and
 *     rebuilds the URL with the fresh port (the caller token stays valid — see
 *     below), so door tools self-heal without any chat injection.
 *
 *   grants.json — { [agentId]: { token, title, mintedAt, lastNotifiedPort } }
 *     L1/L2 grant tokens for mains created BEFORE the plugin (no door in their
 *     record). The plugin ADOPTS all of them at startup, so a grant minted by a
 *     previous plugin process keeps working after a restart. Child tokens need
 *     no file — they already live in their agent records (spec v12 pa1).
 *
 * Writes are atomic (tmp + rename); the plugin is the only writer. Reads are
 * best-effort — any missing/corrupt file degrades to the pre-F10 behavior.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { TokenRegistry } from "./tokens.js";

export function pluginDataDir(): string {
	return join(homedir(), ".paseo", "plugin-data", "paseo-subagents");
}

export function doorStatePath(dir: string = pluginDataDir()): string {
	return join(dir, "door-state.json");
}

export function grantsPath(dir: string = pluginDataDir()): string {
	return join(dir, "grants.json");
}

export interface DoorState {
	port: number;
	updatedAt: number;
}

function atomicWriteJson(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf-8");
	renameSync(tmp, file);
}

/** Persist the current listener port (called once per process, right after bind). */
export function writeDoorState(dir: string, port: number): void {
	atomicWriteJson(doorStatePath(dir), { port, updatedAt: Date.now() });
}

export function readDoorState(dir: string): DoorState | null {
	try {
		const raw = JSON.parse(readFileSync(doorStatePath(dir), "utf-8")) as { port?: unknown };
		if (typeof raw.port !== "number" || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) return null;
		return { port: raw.port, updatedAt: Date.now() };
	} catch {
		return null;
	}
}

export interface GrantEntry {
	token: string;
	title: string;
	mintedAt: number;
	/** Port the last [door-grant] message carried — notification dedupe (F10):
	 *  re-notify only when the port rotated, not on every turn. */
	lastNotifiedPort?: number;
}

/** File-backed store for main grant tokens. Satisfies grant.ts's GrantPersistence
 *  interface (restore/persist) and adds startup adoption + notify dedupe. */
export class GrantStore {
	private readonly dir: string;

	constructor(dir: string = pluginDataDir()) {
		this.dir = dir;
	}

	private read(): Record<string, GrantEntry> {
		const file = grantsPath(this.dir);
		if (!existsSync(file)) return {};
		try {
			const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, GrantEntry>;
			return raw && typeof raw === "object" ? raw : {};
		} catch {
			return {};
		}
	}

	private write(all: Record<string, GrantEntry>): void {
		atomicWriteJson(grantsPath(this.dir), all);
	}

	/** Full entry (incl. lastNotifiedPort) — null when never granted. */
	entryFor(agentId: string): GrantEntry | null {
		return this.read()[agentId] ?? null;
	}

	/** GrantPersistence.restore — { token, title } or null. */
	restore(agentId: string): { token: string; title: string } | null {
		const e = this.entryFor(agentId);
		return e ? { token: e.token, title: e.title } : null;
	}

	/** GrantPersistence.persist — record a freshly minted grant token. */
	persist(agentId: string, token: string, title: string): void {
		const all = this.read();
		const prev = all[agentId];
		all[agentId] = { token, title, mintedAt: Date.now(), lastNotifiedPort: prev?.lastNotifiedPort };
		this.write(all);
	}

	markNotified(agentId: string, port: number): void {
		const all = this.read();
		if (!all[agentId]) return;
		all[agentId].lastNotifiedPort = port;
		this.write(all);
	}

	/** Startup adoption: re-register every persisted grant token in THIS process
	 *  registry so restarts do not kill previously granted mains. Returns the
	 *  number of adopted tokens. */
	adoptAll(registry: TokenRegistry): number {
		let adopted = 0;
		for (const [agentId, entry] of Object.entries(this.read())) {
			try {
				registry.adopt(entry.token, {
					parentId: agentId,
					title: entry.title,
					depth: 0,
					canSpawn: true,
					boundAgentId: agentId,
				});
				adopted += 1;
			} catch {
				// Invalid token (charset/length) — skip; it can never verify anyway.
			}
		}
		return adopted;
	}
}
