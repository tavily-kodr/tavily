/** Small statistics helpers shared by the measurement scripts. */

/** Median of a non-empty list (mean of the two middle values when even); 0 when empty. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2 : (s[mid] ?? 0);
}

/** Nearest-rank percentile, p in (0, 1]; 0 when empty. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(p * s.length) - 1)] ?? 0;
}

export interface Summary {
  min: number;
  median: number;
  p90: number;
  p95: number;
  max: number;
}

export function summarize(values: readonly number[]): Summary {
  return {
    min: values.length ? Math.min(...values) : 0,
    median: median(values),
    p90: percentile(values, 0.9),
    p95: percentile(values, 0.95),
    max: values.length ? Math.max(...values) : 0,
  };
}
