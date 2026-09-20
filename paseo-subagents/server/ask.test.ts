import { describe, expect, test } from "bun:test";
import { canAnswer, makeQuestionId, validateAnswer, validateQuestion, type PendingQuestion } from "./ask";

describe("validate", () => {
  test("question/answer: nhận string không rỗng, trim không", () => {
    expect(validateQuestion("hỏi gì đó").ok).toBe(true);
    expect(validateQuestion("   ").ok).toBe(false);
    expect(validateQuestion(5).ok).toBe(false);
    expect(validateAnswer("q-1", "đáp").ok).toBe(true);
    expect(validateAnswer("", "đáp").ok).toBe(false);
    expect(validateAnswer("q-1", " ").ok).toBe(false);
  });
});

describe("canAnswer", () => {
  test("chỉ đúng parent của câu hỏi", () => {
    const p: PendingQuestion = { questionId: "q-1", childId: "c", parentId: "p1", createdAt: 0 };
    expect(canAnswer(p, "p1")).toBe(true);
    expect(canAnswer(p, "p2")).toBe(false);
    expect(canAnswer(p, undefined)).toBe(false);
  });
});

describe("makeQuestionId", () => {
  test("duy nhất", () => expect(makeQuestionId()).not.toBe(makeQuestionId()));
});
