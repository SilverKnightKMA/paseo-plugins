import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { pokeEngineBridges } from "./doorbell-poke.js";
import { homedir } from "node:os";

/** HOME resolution: env first (tests + containers), os fallback. */
function homeDir(): string {
	return process.env.HOME && process.env.HOME.trim() ? process.env.HOME : homedir();
}
import { join } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import { GetMemoryStateRpc, MemoryUntombstoneRpc, type FactRow } from "../shared/rpc.js";

/**
 * Read-only view of the durable facts tier (#181): prefers the engine's
 * facts-status.json projection (source of truth) and re-parses facts.md only
 * for the tombstone list. The un-tombstone RPC writes a control file the
 * ENGINE watches and applies (pattern plan-control) — this server never
 * edits the store itself.
 */

const FACT_LINE_RE =
	/^\[(identity|preference|convention|project|decision|ops)\]\[(\d{4}-\d{2}-\d{2})\]\[(P[123])\] (.+?) \(#([a-f0-9]{6})\)(?: ttl=(\d{4}-\d{2}-\d{2}))?(?: tombstoned=(\d{4}-\d{2}-\d{2}) reason=(.*))?$/;

function factsPath(): string {
	const override = process.env.FACTS_FILE;
	if (override && override.trim().length > 0) return override;
	return join(homeDir(), ".pi", "agent", "facts.md");
}

function statusPath(): string {
	return join(homeDir(), ".pi", "agent", "facts-status.json");
}

function controlDir(): string {
	return join(homeDir(), ".pi", "agent", "facts-control");
}

export function parseFactLines(content: string): FactRow[] {
	const rows: FactRow[] = [];
	for (const raw of content.split("\n")) {
		const m = FACT_LINE_RE.exec(raw.trim());
		if (!m) continue;
		rows.push({
			id: m[5],
			category: m[1],
			date: m[2],
			priority: m[3],
			text: m[4],
			ttl: m[6] ?? null,
			tombstoned: m[7] ?? null,
			reason: m[8] ?? null,
		});
	}
	return rows;
}

export async function memoryStateHandler(_input: RpcInput<typeof GetMemoryStateRpc>) {
	const file = factsPath();
	let filePresent = false;
	let mtime: string | null = null;
	let raw = "";
	try {
		filePresent = existsSync(file);
		if (filePresent) {
			raw = readFileSync(file, "utf8");
			mtime = new Date(statSync(file).mtimeMs).toISOString();
		}
	} catch {
		filePresent = false;
	}

	// Projection first (engine-owned); fall back to a direct parse when the
	// engine has not written it yet (plugin installed before first session).
	let proj: Record<string, unknown> | null = null;
	try {
		proj = JSON.parse(readFileSync(statusPath(), "utf8"));
	} catch {
		proj = null;
	}
	const rows = parseFactLines(raw);
	const dead = rows
		.filter((r) => r.tombstoned)
		.sort((a, b) => ((a.tombstoned ?? "") < (b.tombstoned ?? "") ? 1 : -1));

	const live = rows.filter((r) => !r.tombstoned).length;
	const fallback = {
		file,
		live,
		tombstoned: dead.length,
		byCategory: Object.entries(
			rows.reduce<Record<string, { live: number; tombstoned: number }>>((acc, r) => {
				const e = acc[r.category] ?? { live: 0, tombstoned: 0 };
				if (r.tombstoned) e.tombstoned++;
				else e.live++;
				acc[r.category] = e;
				return acc;
			}, {}),
		).map(([category, v]) => ({ category, ...v })),
		lastCuration: null,
		curatorFailing: false,
		failingStreak: 0,
		lastError: null,
		nextThresholds: { minLines: 10, minTokens: 2_000_000, minSessions: 15, floorDays: 30 },
	};

	const pick = <T,>(key: string, dflt: T): T => (proj && key in (proj as object) ? ((proj as Record<string, unknown>)[key] as T) : dflt);

	return {
		present: filePresent || Boolean(proj),
		file,
		live: pick<number>("live", fallback.live),
		tombstoned: pick<number>("tombstoned", fallback.tombstoned),
		byCategory: pick<{ category: string; live: number; tombstoned: number }[]>("byCategory", fallback.byCategory),
		lastCuration: (proj && (proj as Record<string, unknown>).lastCuration ? (proj.lastCuration as never) : null),
		curatorFailing: pick<boolean>("curatorFailing", false),
		failingStreak: pick<number>("failingStreak", 0),
		lastError: pick<string | null>("lastError", null),
		nextThresholds: pick("nextThresholds", fallback.nextThresholds),
		mtime,
		generatedAt: new Date().toISOString(),
		tombstones: dead.slice(0, 50),
		note: filePresent ? null : "no facts store yet — the engine creates ~/.pi/agent/facts.md on first durable fact",
	};
}

export async function untombstoneHandler(input: RpcInput<typeof MemoryUntombstoneRpc>) {
	const id = input.id.trim().toLowerCase();
	if (!/^[a-f0-9]{6}$/.test(id)) {
		return { ok: false, queued: false, detail: `id '${id}' is not a 6-hex fact id` };
	}
	try {
		const dir = controlDir();
		mkdirSync(dir, { recursive: true });
		const ctl = join(dir, `untomb-${Date.now()}-${id}.json`);
		writeFileSync(ctl, JSON.stringify({ action: "untombstone", id, ts: new Date().toISOString() }, null, "\t") + "\n");
		void pokeEngineBridges("facts-control", ctl, ""); // #39 bell — global file, engine sweep in ms
		return { ok: true, queued: true, detail: `queued #${id} — the engine applies it and acks the file` };
	} catch (e) {
		return { ok: false, queued: false, detail: String(e).slice(0, 200) };
	}
}
