export function startTimer(): number {
  return performance.now();
}

export function elapsedMs(startTime: number): number {
  const duration = performance.now() - startTime;
  return Math.max(0, Math.round(duration));
}
