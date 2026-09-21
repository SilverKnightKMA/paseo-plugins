/**
 * doorbell-poke (#39 Phase 2) — plugin→engine bell.
 *
 * DISK IS TRUTH: after a plugin WRITES a control file (task-control,
 * goal-control, snip-control, facts-control, plan-control) it pokes every
 * engine session socket under ~/.pi/agent/bridges/ so the owning engine
 * applies the file in ms instead of waiting on fs.watch (which stays as
 * the engine-side backstop). No data crosses the socket beyond the bell.
 *
 * Payload contract (v1): one line of JSON, then close — the same shape the
 * engine dispatcher validates:
 *   {"v":1,"sessionId":"<session or '' for global files>","kind":"<control kind>","file":"<abs path>","ts":"<ISO>"}
 *
 * Never-throws contract: a missing bridges dir (engine not running / plain
 * pi without the socket) is a silent no-op — the engine's fs.watch still
 * applies the file within its debounce window. Fire-and-forget safe.
 */

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";

export const DOORBELL_POKE_VERSION = 1;

/** Safety cap: never iterate an absurd number of sockets from one poke. */
const MAX_SOCKETS_PER_POKE = 16;
/** Per-socket budget: a bell must never delay the writer meaningfully. */
const CONNECT_TIMEOUT_MS = 300;

/** Engine bridges dir (override via opts.dir for tests). */
export function engineBridgesDir(opts: { dir?: string } = {}): string {
	if (opts.dir) return opts.dir;
	return join(process.env.HOME ?? homedir(), ".pi", "agent", "bridges");
}

function pokeOne(sockPath: string, line: string): Promise<void> {
	return new Promise((resolve) => {
		let settled = false;
		const done = () => {
			if (!settled) {
				settled = true;
				resolve();
			}
		};
		try {
			const sock = createConnection({ path: sockPath });
			sock.setTimeout(CONNECT_TIMEOUT_MS);
			sock.on("connect", () => {
				try {
					sock.write(`${line}\n`);
				} catch {
					/* bell only — ignore */
				}
				sock.destroy();
				done();
			});
			sock.on("timeout", () => {
				sock.destroy();
				done();
			});
			sock.on("error", () => {
				/* dead/stale socket — normal, skip silently */
				done();
			});
		} catch {
			done();
		}
	});
}

/**
 * Fan-out one bell line to every engine session socket. Fire-and-forget
 * safe (callers may `void` it); NEVER throws.
 */
export async function pokeEngineBridges(
	kind: string,
	file: string,
	sessionId: string,
	opts: { dir?: string } = {},
): Promise<void> {
	try {
		const dir = engineBridgesDir(opts);
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return; // no engine bridges (engine down / socket closed) — fs.watch covers it
		}
		const line = JSON.stringify({
			v: DOORBELL_POKE_VERSION,
			sessionId,
			kind,
			file,
			ts: new Date().toISOString(),
		});
		const sockets = entries.filter((e) => e.endsWith(".sock")).slice(0, MAX_SOCKETS_PER_POKE);
		await Promise.all(sockets.map((e) => pokeOne(join(dir, e), line)));
	} catch {
		/* a bell must never break the writer */
	}
}
