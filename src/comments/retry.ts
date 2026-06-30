export interface RetryDecisionInput {
  retryable: boolean;
  attempt: number;
  maxAttempts: number;
  now: Date;
}

export interface RetryDecision {
  status: "retryable" | "failed";
  nextRetryAt?: string;
}

export function decideRetry(input: RetryDecisionInput): RetryDecision {
  if (!input.retryable || input.attempt >= input.maxAttempts) {
    return { status: "failed" };
  }

  const delaySeconds = retryDelaySeconds(input.attempt);
  return {
    status: "retryable",
    nextRetryAt: new Date(input.now.getTime() + delaySeconds * 1000).toISOString(),
  };
}

function retryDelaySeconds(attempt: number): number {
  if (attempt <= 1) {
    return 60;
  }

  if (attempt === 2) {
    return 5 * 60;
  }

  return 15 * 60;
}
