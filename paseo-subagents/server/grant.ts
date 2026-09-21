/**
 * L1 door-grant (spec v12 mục 11) — main sinh TRƯỚC plugin không có door.
 *
 * Door chỉ được inject ở before(agent.create); main cũ (như session tạo
 * 05/09) có record rỗng mcpServers → mãi mãi không có cửa spawn.
 * L1: khi main đó kết thúc 1 turn (agent.turn_ended), plugin mint token MỚI
 * + bind, rồi gửi `[door-grant] <url>` vào chat qua api.agents.ref(id).send().
 * Main dùng URL bằng HTTP POST tools/call; con spawn qua door này báo
 * [child-report] về đúng main.
 *
 * Guard: đúng 1 lần/process/agent (GrantLedger); bỏ qua archived; bỏ qua child
 * (label subagent.parent); chỉ grant khi record KHÔNG có door (không đè door
 * của ai). Tự lành sau restart (process mới → ledger rỗng → turn kế grant lại).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SubagentReplyRuntime } from "./hooks.js";
import { MAIN_DOOR_KEY, CHILD_DOOR_KEY } from "./adopt.js";

export const DOOR_GRANT_PREFIX = "[door-grant]";

export interface MainDoorState {
  /** Tìm thấy record file của agent này không. */
  found: boolean;
  isChild: boolean;
  archived: boolean;
  /** Record đã có door URL ở key main hoặc child. */
  hasDoor: boolean;
}

/** Đọc record CHỈ ĐỌC, trả trạng thái door của agent (dùng cho shouldGrant). */
export function readMainDoorState(agentsRoot: string, agentId: string): MainDoorState {
  const empty: MainDoorState = { found: false, isChild: false, archived: false, hasDoor: false };
  if (!existsSync(agentsRoot)) return empty;
  for (const ws of readdirSync(agentsRoot, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const file = join(agentsRoot, ws.name, `${agentId}.json`);
    if (!existsSync(file)) continue;
    try {
      const raw = JSON.parse(readFileSync(file, "utf-8")) as {
        labels?: Record<string, string>;
        archivedAt?: string | null;
        config?: { mcpServers?: Record<string, { url?: string }> };
      };
      const labels = raw.labels ?? {};
      const mainUrl = raw.config?.mcpServers?.[MAIN_DOOR_KEY]?.url;
      const childUrl = raw.config?.mcpServers?.[CHILD_DOOR_KEY]?.url;
      return {
        found: true,
        isChild: typeof labels["subagent.parent"] === "string" && labels["subagent.parent"] !== "",
        archived: typeof raw.archivedAt === "string" && raw.archivedAt !== "",
        hasDoor: Boolean(mainUrl ?? childUrl),
      };
    } catch {
      return empty; // JSON hỏng: coi như không tìm thấy — lần turn sau đọc lại
    }
  }
  return empty;
}

/**
 * Quyết định grant thuần (testable): grant khi và chỉ khi
 * record tồn tại + là main + chưa archived + record KHÔNG có door.
 * (RAM check + ledger check thuộc wiring — bước #156.)
 */
export function shouldGrant(state: MainDoorState): boolean {
  return state.found && !state.isChild && !state.archived && !state.hasDoor;
}

/** Đúng 1 grant mỗi process mỗi agent — tự reset khi plugin restart.
 *  Lưu cả token để L1 (turn_ended message) và L2 (session_open env) DÙNG
 *  CHUNG một token cho cùng agent — không mint đôi. */
export class GrantLedger {
  private readonly byAgent = new Map<string, string>();

  /** true nếu agent này CHƯA được grant trong process hiện tại. */
  allow(agentId: string): boolean {
    return !this.byAgent.has(agentId);
  }

  mark(agentId: string, token: string): void {
    this.byAgent.set(agentId, token);
  }

  /** Token đã grant trong process này (L2 tái dùng), hoặc null. */
  tokenFor(agentId: string): string | null {
    return this.byAgent.get(agentId) ?? null;
  }

  get size(): number {
    return this.byAgent.size;
  }
}

/**
 * L2 env-door (spec v12 mục 11): tính URL door để nhét vào env
 * PASEO_SUBAGENTS_DOOR cho main không-door. Tái dùng token L1 nếu cùng process
 * đã grant; chưa có thì mint mới. Trả null khi không thuộc diện (child/archived/
 * đã-door/không record) hoặc door chưa listen. KHÔNG ghi record.
 */
export function envDoorUrlForMain(agentsRoot: string, rt: SubagentReplyRuntime, ledger: GrantLedger, agentId: string, title: string): string | null {
  const state = readMainDoorState(agentsRoot, agentId);
  if (!shouldGrant(state)) return null;
  const existing = ledger.tokenFor(agentId);
  if (existing) {
    const port = rt.getPort();
    if (port === null) return null;
    return `http://127.0.0.1:${port}/mcp?caller=${existing}`;
  }
  const url = mintDoorForMain(rt, agentId, title);
  if (!url) return null;
  const token = new URL(url).searchParams.get("caller");
  if (!token) return null;
  ledger.mark(agentId, token);
  return url;
}

/**
 * Mint token MỚI cho main cũ + bind ngay (biết agentId rồi — khác create-time
 * mint với parentId='(main)'). Trả URL door hoàn chỉnh để gửi vào chat.
 */
export function mintDoorForMain(rt: SubagentReplyRuntime, agentId: string, title: string): string | null {
  const port = rt.getPort();
  if (port === null) return null; // door chưa listen: bỏ qua lần này, turn sau thử lại
  const token = rt.registry.mint(agentId, title, { depth: 0, canSpawn: true });
  rt.registry.bind(token, agentId);
  const url = `http://127.0.0.1:${port}/mcp?caller=${token}`;
  rt.log(`[paseo-subagents] door-grant mint: agent ${agentId} ('${title}') — token ${token.slice(0, 8)}…`);
  return url;
}

/** Định dạng tin nhắn grant (tiêu đề hằng để phía main/E2E grep dễ). */
export function doorGrantMessage(url: string): string {
  return `${DOOR_GRANT_PREFIX} ${url}`;
}
