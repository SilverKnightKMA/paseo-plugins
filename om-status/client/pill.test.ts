import { describe, expect, test } from "bun:test";
import { startOmLive } from "./pill.js";
import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";

/** #244 (M1): fake client exercising the pill starter — registration
 *  resilience (a throw must not kill the topics pill or later syncs) and the
 *  M3 topics pill behavior. */
function fakeClient(opts: { failStatusPill?: boolean } = {}) {
	const pills: { id: string; contribution: Record<string, unknown>; reg: PluginButtonRegistration }[] = [];
	const openedPanels: { id: string; options?: unknown }[] = [];
	const errors: string[] = [];
	const origError = console.error;
	const origInfo = console.info;
	console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));
	console.info = () => {};
	const client = {
		addComposerPill: (contribution: Record<string, unknown>) => {
			if (opts.failStatusPill && String(contribution.id).startsWith("om-status-pill-")) {
				throw new Error("validation boom");
			}
			const entry = { id: String(contribution.id), contribution, reg: null as unknown as PluginButtonRegistration };
			entry.reg = {
				update: () => {},
				remove: () => {
					const i = pills.indexOf(entry);
					if (i >= 0) pills.splice(i, 1);
				},
			} as PluginButtonRegistration;
			pills.push(entry);
			return entry.reg;
		},
		openPanel: (id: string, options?: unknown) => {
			openedPanels.push({ id, options });
		},
		rpc: async () => null,
		paseo: {
			agents: {
				list: async () => ({ entries: [{ agent: { id: "agent-1", workspaceId: "ws-1" } }] }),
				subscribe: () => () => {},
				ref: () => ({ subscribe: () => () => {} }),
			},
		},
	};
	return {
		client: client as unknown as PluginClientContext,
		pills,
		openedPanels,
		errors,
		restore() {
			console.error = origError;
			console.info = origInfo;
		},
	};
}

describe("#244 pill starter diagnostics + OM Topics pill", () => {
	test("a failing OM-status registration logs the tag and does NOT kill the topics pill", async () => {
		const f = fakeClient({ failStatusPill: true });
		try {
			const stop = startOmLive(f.client);
		 await Bun.sleep(30); // let sync() run
			expect(f.errors.some((e) => e.includes("[pill:om-status] register failed"))).toBe(true);
			const ids = f.pills.map((p) => p.id);
			expect(ids).toContain("om-topics-pill-ws-1/agent-1");
			expect(ids).not.toContain("om-status-pill-ws-1/agent-1");
			stop();
			f.restore();
		} finally {
			f.restore();
		}
	});

	test("topics pill registered per agent; onPress opens the om-topics panel", async () => {
		const f = fakeClient();
		try {
			const stop = startOmLive(f.client);
			await Bun.sleep(30);
			const ids = f.pills.map((p) => p.id);
			expect(ids).toContain("om-status-pill-ws-1/agent-1");
			expect(ids).toContain("om-topics-pill-ws-1/agent-1");
			const topicsPill = f.pills.find((p) => p.id === "om-topics-pill-ws-1/agent-1")!;
			const button = (topicsPill.contribution.button ?? {}) as { behavior?: { onPress?: () => void }; label?: string };
			expect(button.label).toBe("topics");
			button.behavior!.onPress!();
			expect(f.openedPanels.some((p) => p.id === "om-topics")).toBe(true);
			stop();
		} finally {
			f.restore();
		}
	});

	test("agents.list failure is NAMED (no more silent catch)", async () => {
		const f = fakeClient();
		const clientAny = f.client as unknown as { paseo: { agents: { list: () => Promise<unknown> } } };
		clientAny.paseo.agents.list = async () => {
			throw new Error("relay down");
		};
		try {
			const stop = startOmLive(f.client);
			await Bun.sleep(30);
			expect(f.errors.some((e) => e.includes("[pill:om-status] agents.list failed"))).toBe(true);
			stop();
		} finally {
			f.restore();
		}
	});
});
