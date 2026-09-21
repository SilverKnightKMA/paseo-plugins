/**
 * In-memory caller registry for the scoped reply door.
 *
 * Each child spawned with PASEO_PARENT_AGENT_ID gets one opaque token minted
 * at create time. The token is baked into the child's MCP server URL
 * (`/mcp?caller=<token>`) and is the ONLY identity the server trusts:
 * possession of the token proves "I am the agent this URL was minted for".
 * No agent can address any other agent through this door.
 *
 * The registry is process-local — BUT under spec v12 pa1, minted tokens remain in
 * on-disk agent records (the URL is written at creation), so a verification miss
 * can adopt them from disk (RAM is a disk cache — disk is the source of truth).
 * Restarting therefore no longer kills doors permanently.
 */

export interface CallerToken {
  token: string;
  parentId: string;
  title: string;
  mintedAt: number;
  /** Subagent metadata (spec v11 section 6): depth limits recursion; canSpawn filters tools. */
  depth: number;
  canSpawn: boolean;
  role?: string;
  /** The caller's own agentId (bound after agent.created) — used as subagent.parent. */
  boundAgentId?: string;
}

const MAX_TOKENS = 1024;

export class TokenRegistry {
  private readonly byToken = new Map<string, CallerToken>();

  mint(parentId: string, title: string, meta?: { depth?: number; canSpawn?: boolean; role?: string }): string {
    // 192 bits of entropy — unguessable from the child side.
    const token = cryptoRandomToken();
    this.byToken.set(token, {
      token,
      parentId,
      title,
      mintedAt: Date.now(),
      depth: meta?.depth ?? 1,
      canSpawn: meta?.canSpawn ?? false,
      role: meta?.role,
    });
    if (this.byToken.size > MAX_TOKENS) {
      // Map preserves insertion order: drop the oldest entry.
      const oldest = this.byToken.keys().next().value;
      if (oldest !== undefined) this.byToken.delete(oldest);
    }
    return token;
  }

  /**
   * spec v12 pa1: register an ALREADY MINTED token (stored in an on-disk agent
   * record) in RAM after a restart clears the registry. Do NOT create a new token —
   * use the supplied token string, recreate the entry, and bind immediately if
   * agentId is known. Fail closed when full: throw instead of silently evicting
   * a live token.
   */
  adopt(token: string, meta: { parentId: string; title: string; depth?: number; canSpawn?: boolean; role?: string; boundAgentId?: string }): CallerToken {
    if (!/^[0-9a-f]{48}$/.test(token)) {
      throw new Error(`adopt: invalid token (length/charset) — refused`);
    }
    if (this.byToken.has(token)) return this.byToken.get(token)!;
    if (this.byToken.size >= MAX_TOKENS) {
      throw new Error(`adopt: registry full (${MAX_TOKENS}) — fail-closed, no eviction`);
    }
    const entry: CallerToken = {
      token,
      parentId: meta.parentId,
      title: meta.title,
      mintedAt: Date.now(),
      depth: meta.depth ?? 1,
      canSpawn: meta.canSpawn ?? false,
      role: meta.role,
      boundAgentId: meta.boundAgentId,
    };
    this.byToken.set(token, entry);
    return entry;
  }

  /** Bind agentId to a minted token (agent.created arrives later — main mints before it has an ID). */
  bind(token: string, agentId: string): boolean {
    const entry = this.byToken.get(token);
    if (!entry) return false;
    entry.boundAgentId = agentId;
    return true;
  }

  /** Find a token by the door URL in mcpServers config (used in agent.created). */
  findByUrl(url: string): CallerToken | null {
    const token = new URL(url).searchParams.get("caller");
    return token ? (this.byToken.get(token) ?? null) : null;
  }

  verify(token: string | null | undefined): CallerToken | null {
    if (!token) return null;
    return this.byToken.get(token) ?? null;
  }

  get size(): number {
    return this.byToken.size;
  }
}

function cryptoRandomToken(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
