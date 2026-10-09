export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 504);
}

/**
 * Parses the Retry-After header value which can be either seconds or an HTTP-date.
 * Returns the delay in milliseconds.
 */
export function parseRetryAfter(headerValue?: string | null): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();

  // Try parsing as integer seconds
  const seconds = parseInt(trimmed, 10);
  if (!isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  // Try parsing as HTTP-date
  const timestamp = Date.parse(trimmed);
  if (!isNaN(timestamp)) {
    const diff = timestamp - Date.now();
    return Math.max(0, diff);
  }

  return undefined;
}

/**
 * Calculates exponential backoff with full jitter to prevent thundering herd.
 */
export function calculateBackoff(attempt: number, baseDelayMs = 1000, maxDelayMs = 10000): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
  // Full jitter: random between 0 and exponential
  return Math.floor(Math.random() * exponential);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
