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

export interface BackstopHandle {
	/** The raw client — only usable once `ready` resolved true or isConnected() flips. */
	client: BackstopSlice;
	/**
	 * Resolves true once connected; false after the arm timeout. With reconnect
	 * enabled the client keeps retrying past the timeout — a LATE success is
	 * picked up by isConnected() on the next getApi() call, so false here is
	 * "not ready yet", never "never".
	 */
	ready: Promise<boolean>;
	/** Live transport state — true as soon as a background retry landed. */
	isConnected(): boolean;
}

/** Map a PASEO_LISTEN-style host:port onto a loopback http URL (0.0.0.0 is not dialable). */
export function deriveLocalUrl(listen: string | undefined): string {
	const raw = (listen ?? "127.0.0.1:6767").trim() || "127.0.0.1:6767";
	const hostPort = raw.replace(/^0\.0\.0\.0/, "127.0.0.1").replace(/^::$/, "127.0.0.1");
	return `http://${hostPort}`;
}

/**
 * Arm the direct client: construct (never throws) and start dialing. The
 * caller awaits `ready` before touching `client` — PaseoClient rejects
 * requests with "Transport not connected (status: idle)" until connected, so
 * the connect() race must be explicit. Env overrides, in priority order:
 * PASEO_SUBAGENTS_DIRECT_URL (tests / explicit pin) then PASEO_LISTEN
 * (daemon-injected) then the default port.
 */
export function armBackstop(env: NodeJS.ProcessEnv = process.env, armTimeoutMs = 3000): BackstopHandle | null {
	const url = env.PASEO_SUBAGENTS_DIRECT_URL ?? deriveLocalUrl(env.PASEO_LISTEN);
	try {
		const client = createPaseoClient({ url, reconnect: { enabled: true } }) as unknown as {
			connect(): Promise<void>;
			getConnectionState(): { status: string };
		};
		// reconnect-enabled clients retry forever, so a refused port would leave
		// ready pending indefinitely — race the arm timeout instead and let
		// isConnected() unlock a late success on a later call.
		const ready = Promise.race([
			client.connect().then(() => true),
			new Promise<boolean>((resolve) => {
				const t = setTimeout(() => resolve(false), armTimeoutMs);
				t.unref?.();
			}),
		]).catch((err: unknown) => {
			console.log(
				`[paseo-subagents] direct backstop connect failed (${url}): ${err instanceof Error ? err.message : String(err)} — staying on lifecycle capture`,
			);
			return false;
		});
		return {
			client: client as unknown as BackstopSlice,
			ready,
			isConnected: () => client.getConnectionState?.().status === "connected",
		};
	} catch {
		// Factory refused (bad URL shape) — stay null; lifecycle capture remains.
		return null;
	}
}
