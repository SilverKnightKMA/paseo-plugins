import { describe, expect, test } from "bun:test";
import {
  aggregatePoolReport,
  allTerminal,
  childTerminal,
  makePoolId,
  scheduleBatches,
  validatePoolArgs,
} from "./pool";

describe("validatePoolArgs", () => {
  test("chấp nhận 2-12 items, clamp concurrency 1-4, default 4", () => {
    const r = validatePoolArgs(
      [
        { role: "scout", task: "a" },
        { role: "scout", task: "b" },
      ],
      99,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pool.concurrency).toBe(4);
    const c0 = validatePoolArgs(
      [
        { role: "scout", task: "a" },
        { role: "scout", task: "b" },
      ],
      0,
    );
    expect(c0.ok && c0.pool.concurrency).toBe(1);
  });

  test("từ chối <2 items, >12 items, item thiếu role/task", () => {
    expect(validatePoolArgs([{ role: "scout", task: "a" }], 4).ok).toBe(false);
    expect(validatePoolArgs(Array.from({ length: 13 }, () => ({ role: "scout", task: "x" })), 4).ok).toBe(false);
    expect(
      validatePoolArgs(
        [
          { role: "", task: "a" },
          { role: "scout", task: "b" },
        ],
        4,
      ).ok,
    ).toBe(false);
    expect(validatePoolArgs("nope", 4).ok).toBe(false);
  });

  test("name không-string bị drop, string giữ nguyên", () => {
    const r = validatePoolArgs(
      [
        { role: "scout", task: "a", name: 5 },
        { role: "scout", task: "b", name: "ten" },
      ],
      2,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pool.items[0].name).toBeUndefined();
      expect(r.pool.items[1].name).toBe("ten");
    }
  });
});

describe("scheduleBatches", () => {
  test("chia đúng: 6 items concurrency 4 -> [4,2]", () => {
    const batches = scheduleBatches([1, 2, 3, 4, 5, 6], 4);
    expect(batches.map((b) => b.length)).toEqual([4, 2]);
  });

  test("concurrency lớn hơn số items -> 1 batch", () => {
    expect(scheduleBatches([1, 2], 4)).toEqual([[1, 2]]);
  });

  test("clamp về 1-4", () => {
    expect(scheduleBatches([1, 2, 3], 0).map((b) => b.length)).toEqual([1, 1, 1]);
  });
});

describe("terminal & aggregate", () => {
  test("idle/error/archived là terminal; running/initializing/waiting không", () => {
    expect(childTerminal({ id: "a", lastStatus: "idle" })).toBe(true);
    expect(childTerminal({ id: "a", lastStatus: "error" })).toBe(true);
    expect(childTerminal({ id: "a", lastStatus: "idle", archivedAt: "x" })).toBe(true);
    expect(childTerminal({ id: "a", lastStatus: null })).toBe(false);
    expect(childTerminal({ id: "a", lastStatus: "running" })).toBe(false);
  });

  test("allTerminal: true khi mọi con terminal, false khi còn 1 running, false khi rỗng", () => {
    expect(allTerminal([{ id: "a", lastStatus: "idle" }, { id: "b", lastStatus: "error" }])).toBe(true);
    expect(allTerminal([{ id: "a", lastStatus: "idle" }, { id: "b", lastStatus: "running" }])).toBe(false);
    expect(allTerminal([])).toBe(false);
  });

  test("aggregatePoolReport đếm ok/lỗi và liệt kê từng con", () => {
    const text = aggregatePoolReport(
      "pool-x",
      [
        { id: "a", lastStatus: "idle" },
        { id: "b", lastStatus: "error" },
      ],
      (c) => ({ label: c.id === "a" ? "scout A" : "scout B", state: c.lastStatus ?? "?" }),
    );
    expect(text).toContain("[pool-report] pool pool-x hoàn tất: 2 children terminal (ok 1, lỗi/archived 1)");
    expect(text).toContain("- scout A: idle");
    expect(text).toContain("- scout B: error");
  });
});

describe("makePoolId", () => {
  test("duy nhất giữa 2 lần gọi liền nhau", () => {
    expect(makePoolId()).not.toBe(makePoolId());
  });
});
