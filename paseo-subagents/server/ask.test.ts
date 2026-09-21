import { describe, expect, test } from "bun:test";
import { canAnswer, makeQuestionId, validateAnswer, validateQuestion, type PendingQuestion } from "./ask";

describe("validate", () => {
  test("question/answer: accepts non-empty strings without trimming", () => {
    expect(validateQuestion("ask something").ok).toBe(true);
    expect(validateQuestion("   ").ok).toBe(false);
    expect(validateQuestion(5).ok).toBe(false);
    expect(validateAnswer("q-1", "answer").ok).toBe(true);
    expect(validateAnswer("", "answer").ok).toBe(false);
    expect(validateAnswer("q-1", " ").ok).toBe(false);
  });
});

describe("canAnswer", () => {
  test("only the question's parent can answer", () => {
    const p: PendingQuestion = { questionId: "q-1", childId: "c", parentId: "p1", createdAt: 0 };
    expect(canAnswer(p, "p1")).toBe(true);
    expect(canAnswer(p, "p2")).toBe(false);
    expect(canAnswer(p, undefined)).toBe(false);
  });
});

describe("makeQuestionId", () => {
  test("is unique", () => expect(makeQuestionId()).not.toBe(makeQuestionId()));
});
