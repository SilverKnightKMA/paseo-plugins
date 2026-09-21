/**
 * pa1 adopt-from-disk (spec v12 mục 11) — durability door token sau restart.
 *
 * Bối cảnh: TokenRegistry là RAM; plugin restart làm mọi door chết vĩnh viễn vì
 * verify-miss chỉ biết 401. Nhưng token ĐÃ MINT nằm nguyên trong record agent
 * trên đĩa (`config.mcpServers[...].url?caller=<token>` ghi lúc create).
 * adoptFromRecord: khi 1 request mang token lạ tới door (verify-miss), đọc
 * record tìm đúng token đó → đăng ký lại CÙNG token string vào RAM + bind.
 *
 * Nguyên tắc (bất di bất dịch v12):
 * - CHỈ ĐỌC record (tài sản daemon — không ghi, không đổi URL).
 * - KHÔNG mint token mới, KHÔNG quét nền — chạy đúng lúc request tới (event-driven).
 * - Không thấy token trong record nào → null → caller 401 như cũ (fail-honest).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TokenRegistry } from "./tokens.js";

export const MAIN_DOOR_KEY = "paseo-subagents";
export const CHILD_DOOR_KEY = "paseo";

export interface AdoptHit {
  agentId: string;
  title: string;
  url: string;
  isChild: boolean;
  depth: number;
  role?: string;
}

interface RawRecord {
  id?: string;
  title?: string;
  labels?: Record<string, string>;
  archivedAt?: string | null;
  config?: { mcpServers?: Record<string, { url?: string }> };
}

/** Đọc record file, trích door URL (main key trước, child key sau) + metadata. */
function readRecord(file: string): { id: string; title: string; url: string; isChild: boolean; depth: number; role?: string; archived: boolean } | null {
  let raw: RawRecord;
  try {
    raw = JSON.parse(readFileSync(file, "utf-8")) as RawRecord;
  } catch {
    return null; // JSON đang ghi dở / hỏng — bỏ qua, lần miss sau đọc lại
  }
  const id = raw.id ?? "";
  if (!id) return null;
  const mainUrl = raw.config?.mcpServers?.[MAIN_DOOR_KEY]?.url;
  const childUrl = raw.config?.mcpServers?.[CHILD_DOOR_KEY]?.url;
  const url = mainUrl ?? childUrl;
  if (!url) return null; // record không door-hóa — không phải ứng viên
  const labels = raw.labels ?? {};
  const isChild = typeof labels["subagent.parent"] === "string" && labels["subagent.parent"] !== "";
  const depthRaw = Number(labels["subagent.depth"]);
  return {
    id,
    title: raw.title ?? "untitled",
    url,
    isChild,
    depth: Number.isFinite(depthRaw) && depthRaw > 0 ? depthRaw : 1,
    role: labels["subagent.role"],
    archived: typeof raw.archivedAt === "string" && raw.archivedAt !== "",
  };
}

/**
 * Quét agentsRoot CHỈ ĐỌC, tìm record có door URL chứa đúng token.
 * Trả bản ghi non-archived đầu tiên theo thứ tự alphabet id; nếu chỉ thấy trong
 * record archived → vẫn trả (door token chưa chắc đã chết) kèm hit.archived.
 * Token phải khớp CHÍNH XÁC (so cả 48 hex chars trong caller param).
 */
export function findRecordByToken(agentsRoot: string, token: string): (AdoptHit & { archived: boolean }) | null {
  if (!/^[0-9a-f]{48}$/.test(token)) return null;
  if (!existsSync(agentsRoot)) return null;
  const want = `caller=${token}`;
  const candidates: Array<{ file: string; hit: AdoptHit & { archived: boolean } }> = [];
  for (const ws of readdirSync(agentsRoot, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    for (const f of readdirSync(join(agentsRoot, ws.name), { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith(".json")) continue;
      const file = join(agentsRoot, ws.name, f.name);
      const rec = readRecord(file);
      if (!rec) continue;
      const u = rec.url;
      if (!u.includes(want)) continue;
      // caller param phải CHÍNH LÀ token (chống prefix-match nhầm token cùng đầu)
      const param = u.slice(u.indexOf("caller=") + 7).split("&")[0];
      if (param !== token) continue;
      candidates.push({ file, hit: { agentId: rec.id, title: rec.title, url: rec.url, isChild: rec.isChild, depth: rec.depth, role: rec.role, archived: rec.archived } });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  if (candidates.length > 1) {
    console.warn(`[paseo-subagents] adopt: ${candidates.length} record cùng token (bất thường) — lấy đầu theo alphabet: ${candidates[0].file}`);
  }
  const pick = candidates.find((c) => !c.hit.archived) ?? candidates[0];
  return pick.hit;
}

/**
 * Suy caps từ record: child (label subagent.parent) → canSpawn=false, depth từ
 * label; main → canSpawn=true, depth 0. Gọi registry.adopt CÙNG token string.
 * Trả entry đã sống lại trong RAM, hoặc null (không thấy → caller 401 như cũ).
 */
export function adoptFromRecord(agentsRoot: string, token: string, registry: TokenRegistry): { agentId: string; isChild: boolean } | null {
  const hit = findRecordByToken(agentsRoot, token);
  if (!hit) return null;
  try {
    registry.adopt(token, {
      parentId: hit.isChild ? "adopted-from-record" : hit.agentId,
      title: hit.title,
      depth: hit.isChild ? hit.depth : 0,
      canSpawn: !hit.isChild,
      role: hit.role,
      boundAgentId: hit.agentId,
    });
  } catch (err) {
    console.error(`[paseo-subagents] adopt token ${token.slice(0, 8)}… thất bại: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  console.log(`[paseo-subagents] adopt token ${token.slice(0, 8)}… <- record ${hit.agentId} (${hit.isChild ? `child depth ${hit.depth}` : "main"})`);
  return { agentId: hit.agentId, isChild: hit.isChild };
}
