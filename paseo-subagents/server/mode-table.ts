/**
 * Normalized mode knob -> provider-specific modeId translation table.
 *
 * Paseo does NOT normalize modes across providers (verified in daemon source:
 * each provider adapter carries its own mode list). This table is the single
 * place where the parent-facing knob (read-only | auto | review | full) maps
 * onto harness presets:
 *
 *   codex  (codex-app-server-agent.js MODE_PRESETS):
 *     read-only  -> "read-only"     (approvalPolicy on-request + sandbox read-only, hidden preset)
 *     auto       -> "auto"          (on-request + workspace-write; approvals go to the CALLER/parent)
 *     review     -> "auto-review"   (on-request + workspace-write; eligible approvals routed to an AI reviewer)
 *     full       -> "full-access"   (never + danger-full-access)
 *
 *   claude  (claude/agent.js DEFAULT_MODES):
 *     read-only  -> "plan"            (analyze without tools/edits)
 *     auto       -> "default"         (always ask — prompts go to the parent)
 *     review     -> "auto"            (model classifier reviews permission prompts)
 *     full       -> "bypassPermissions" (skip all prompts)
 *
 *   pi: throws on selectable modes — containment comes from pi extension
 *   roles instead; the knob is accepted but never written to modeId.
 */

export const NORMALIZED_MODES = ["read-only", "auto", "review", "full"] as const;
export type NormalizedMode = (typeof NORMALIZED_MODES)[number];

export function isNormalizedMode(value: unknown): value is NormalizedMode {
  return typeof value === "string" && (NORMALIZED_MODES as readonly string[]).includes(value);
}

const PROVIDER_MODE_TABLE: Record<string, Partial<Record<NormalizedMode, string>>> = {
  codex: {
    "read-only": "read-only",
    auto: "auto",
    review: "auto-review",
    full: "full-access",
  },
  claude: {
    "read-only": "plan",
    auto: "default",
    review: "auto",
    full: "bypassPermissions",
  },
  // pi exposes no selectable modes; roles are the containment layer.
  pi: {},
};

/** "codex/gpt-5.6-luna" -> "codex"; "pi" -> "pi". */
export function providerFamily(provider: string): string {
  const slash = provider.indexOf("/");
  return slash === -1 ? provider : provider.slice(0, slash);
}

export interface ModeDecision {
  /** Provider modeId to write into AgentSessionConfig, if any. */
  modeId?: string;
  /** Whether the provider family has a verified entry in the table. */
  providerKnown: boolean;
  /** Honest warning when the knob cannot be enforced for this provider. */
  warning?: string;
}

export function translateMode(provider: string, normalized: NormalizedMode): ModeDecision {
  const family = providerFamily(provider);
  const table = PROVIDER_MODE_TABLE[family];
  if (!table) {
    return {
      providerKnown: false,
      warning: `no verified mode table for provider '${family}'; mode '${normalized}' left to provider defaults — containment unverified`,
    };
  }
  const modeId = table[normalized];
  if (!modeId) {
    return {
      providerKnown: true,
      warning: `provider '${family}' has no selectable modes; requested '${normalized}' ignored (containment comes from another layer)`,
    };
  }
  return { modeId, providerKnown: true };
}

export interface FloorDecision {
  ok: boolean;
  reason?: string;
}

/**
 * Fail-closed floor: refuse spawns whose requested containment cannot be
 * verified. `full` is refused unless the operator explicitly opted in via
 * daemon env SUBAGENT_REPLY_ALLOW_FULL=1, and is ALWAYS refused for providers
 * without a verified mode table (we cannot prove the cage exists there).
 */
export function checkFloor(provider: string, normalized: NormalizedMode, allowFull: boolean): FloorDecision {
  const family = providerFamily(provider);
  const known = family in PROVIDER_MODE_TABLE;
  if (normalized === "full") {
    if (!allowFull) {
      return { ok: false, reason: `mode 'full' is below the fail-closed floor; set daemon env SUBAGENT_REPLY_ALLOW_FULL=1 to opt in explicitly` };
    }
    if (!known) {
      return { ok: false, reason: `provider '${family}' has no verified mode table; 'full' access cannot be verified, refusing spawn` };
    }
  }
  return { ok: true };
}
