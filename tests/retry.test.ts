import { describe, expect, test } from "bun:test";
import { decideRetry } from "../src/comments/retry";

describe("retry decision", () => {
  test("schedules retryable errors before max attempts", () => {
    const decision = decideRetry({
      retryable: true,
      attempt: 1,
      maxAttempts: 3,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    expect(decision.status).toBe("retryable");
    expect(decision.nextRetryAt).toBe("2026-05-05T12:01:00.000Z");
  });

  test("fails non-retryable errors and exhausted attempts", () => {
    const now = new Date("2026-05-05T12:00:00.000Z");

    expect(decideRetry({ retryable: false, attempt: 1, maxAttempts: 3, now }).status).toBe(
      "failed",
    );
    expect(decideRetry({ retryable: true, attempt: 3, maxAttempts: 3, now }).status).toBe(
      "failed",
    );
  });
});
