/**
 * paseo-subagents — #277 direct backstop client.
 *
 * After a mid-turn `paseo plugin reload` no agent.* lifecycle event fires
 * before the caller's next tool call (the turn already started during the
 * restart window), so the captured paseoApi stays null for the WHOLE turn and
 * every spawn fails with "not captured". The daemon's local listener
 * (PASEO_LISTEN) accepts unauthenticated loopback connections — the CLI relies
 * on this — so a standalone client built once on demand closes the gap without
 * waiting for any event. Lifecycle-captured api stays preferred (it carries
 * the plugin's daemon context); the backstop is a fallback, never a
 * replacement.
 */
import { createPaseoClient } from "@getpaseo/client";

export interface BackstopSlice {
	agents: unknown;
}

/** Map a PASEO_LISTEN-style host:port onto a loopback http URL (0.0.0.0 is not dialable). */
export function deriveLocalUrl(listen: string | undefined): string {
	const raw = (listen ?? "127.0.0.1:6767").trim() || "127.0.0.1:6767";
	const hostPort = raw.replace(/^0\.0\.0\.0/, "127.0.0.1").replace(/^::$/, "127.0.0.1");
	return `http://${hostPort}`;
}

/**
 * Build the direct client once. Construction does NOT dial (the client is
 * lazy/connect-on-use), so arming it can never throw for a down daemon — the
 * first real call surfaces any connection error instead.
 * Env overrides, in priority order: PASEO_SUBAGENTS_DIRECT_URL (tests /
 * explicit pin) then PASEO_LISTEN (daemon-injected) then the default port.
 */
export function makeBackstop(env: NodeJS.ProcessEnv = process.env): BackstopSlice | null {
	const url = env.PASEO_SUBAGENTS_DIRECT_URL ?? deriveLocalUrl(env.PASEO_LISTEN);
	try {
		const client = createPaseoClient({ url, reconnect: { enabled: true } });
		return client as unknown as BackstopSlice;
	} catch {
		// Factory refused (bad URL shape) — stay null; lifecycle capture remains.
		return null;
	}
}
