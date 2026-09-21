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
  test("accepts 2-12 items, clamps concurrency to 1-4, and defaults to 4", () => {
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

  test("rejects <2 items, >12 items, and items missing role/task", () => {
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

  test("drops a non-string name and preserves a string name", () => {
    const r = validatePoolArgs(
      [
        { role: "scout", task: "a", name: 5 },
        { role: "scout", task: "b", name: "name" },
      ],
      2,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pool.items[0].name).toBeUndefined();
      expect(r.pool.items[1].name).toBe("name");
    }
  });
});

describe("scheduleBatches", () => {
  test("splits correctly: 6 items with concurrency 4 -> [4,2]", () => {
    const batches = scheduleBatches([1, 2, 3, 4, 5, 6], 4);
    expect(batches.map((b) => b.length)).toEqual([4, 2]);
  });

  test("concurrency greater than item count -> 1 batch", () => {
    expect(scheduleBatches([1, 2], 4)).toEqual([[1, 2]]);
  });

  test("clamps to 1-4", () => {
    expect(scheduleBatches([1, 2, 3], 0).map((b) => b.length)).toEqual([1, 1, 1]);
  });
});

describe("terminal & aggregate", () => {
  test("idle/error/archived are terminal; running/initializing/waiting are not", () => {
    expect(childTerminal({ id: "a", lastStatus: "idle" })).toBe(true);
    expect(childTerminal({ id: "a", lastStatus: "error" })).toBe(true);
    expect(childTerminal({ id: "a", lastStatus: "idle", archivedAt: "x" })).toBe(true);
    expect(childTerminal({ id: "a", lastStatus: null })).toBe(false);
    expect(childTerminal({ id: "a", lastStatus: "running" })).toBe(false);
  });

  test("allTerminal: true when every child is terminal, false with one running or with no children", () => {
    expect(allTerminal([{ id: "a", lastStatus: "idle" }, { id: "b", lastStatus: "error" }])).toBe(true);
    expect(allTerminal([{ id: "a", lastStatus: "idle" }, { id: "b", lastStatus: "running" }])).toBe(false);
    expect(allTerminal([])).toBe(false);
  });

  test("aggregatePoolReport counts ok/failed children and lists each child", () => {
    const text = aggregatePoolReport(
      "pool-x",
      [
        { id: "a", lastStatus: "idle" },
        { id: "b", lastStatus: "error" },
      ],
      (c) => ({ label: c.id === "a" ? "scout A" : "scout B", state: c.lastStatus ?? "?" }),
    );
    expect(text).toContain("[pool-report] pool pool-x complete: 2 children terminal (ok 1, failed/archived 1)");
    expect(text).toContain("- scout A: idle");
    expect(text).toContain("- scout B: error");
  });
});

describe("makePoolId", () => {
  test("is unique across two consecutive calls", () => {
    expect(makePoolId()).not.toBe(makePoolId());
  });
});
