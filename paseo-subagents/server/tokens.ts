/**
 * In-memory caller registry for the scoped reply door.
 *
 * Each child spawned with PASEO_PARENT_AGENT_ID gets one opaque token minted
 * at create time. The token is baked into the child's MCP server URL
 * (`/mcp?caller=<token>`) and is the ONLY identity the server trusts:
 * possession of the token proves "I am the agent this URL was minted for".
 * No agent can address any other agent through this door.
 *
 * Registry is process-local — NHƯNG spec v12 pa1: token đã mint nằm trong record
 * agent trên đĩa (URL ghi lúc create), verify-miss có thể adopt lại từ đĩa
 * (RAM = cache của đĩa — disk-is-truth), nên restart không còn giết door vĩnh viễn.
 */

export interface CallerToken {
  token: string;
  parentId: string;
  title: string;
  mintedAt: number;
  /** subagent metadata (spec v11 mục 6): depth để kìm đệ quy, canSpawn để lọc tool. */
  depth: number;
  canSpawn: boolean;
  role?: string;
  /** AgentId của chính caller (bind sau agent.created) — dùng làm subagent.parent. */
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
   * spec v12 pa1: đăng ký lại token ĐÃ MINT (tồn tại trong record agent trên đĩa) vào
   * RAM sau khi registry mất vì restart. KHÔNG sinh token mới — nhận nguyên token
   * string cho sẵn, tái lập entry + bind ngay nếu biết agentId. Fail-closed khi đầy:
   * throw thay vì evict thầm lặng (token đang sống không bị đá oan).
   */
  adopt(token: string, meta: { parentId: string; title: string; depth?: number; canSpawn?: boolean; role?: string; boundAgentId?: string }): CallerToken {
    if (!/^[0-9a-f]{48}$/.test(token)) {
      throw new Error(`adopt: token không hợp lệ (độ dài/charset) — từ chối`);
    }
    if (this.byToken.has(token)) return this.byToken.get(token)!;
    if (this.byToken.size >= MAX_TOKENS) {
      throw new Error(`adopt: registry đầy (${MAX_TOKENS}) — fail-closed, không evict`);
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

  /** Gắn agentId cho token đã mint (agent.created về sau — main mint trước khi có id). */
  bind(token: string, agentId: string): boolean {
    const entry = this.byToken.get(token);
    if (!entry) return false;
    entry.boundAgentId = agentId;
    return true;
  }

  /** Tìm token theo URL door trong config mcpServers (dùng ở agent.created). */
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
