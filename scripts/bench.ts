/**
 * Load test for the local API: 200 requests at concurrency 10.
 * Prints p50/p95/p99 latency, cache hit rate and requests per second.
 *
 * Usage: node scripts/bench.ts
 * Env:   API_URL (default http://localhost:3000), TOTAL (default 200), CONCURRENCY (default 10)
 */

const API_URL = process.env["API_URL"] ?? "http://localhost:3000";
const TOTAL = Number(process.env["TOTAL"] ?? 200);
const CONCURRENCY = Number(process.env["CONCURRENCY"] ?? 10);

// A small pool of queries, cycled, so repeats exercise the cache.
const QUERIES = [
  "what is python",
  "what is kubernetes",
  "who is ada lovelace",
  "how to install node.js",
  "latest technology news",
  "how to bake sourdough bread",
  "what is quantum computing",
  "jaguar",
  "java",
  "apple",
];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

async function main(): Promise<void> {
  const latencies: number[] = [];
  let next = 0;
  let cacheHits = 0;
  let errors = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= TOTAL) return;
      const q = QUERIES[i % QUERIES.length] ?? "python";
      const started = performance.now();
      try {
        const res = await fetch(`${API_URL}/search?${new URLSearchParams({ q })}`, {
          signal: AbortSignal.timeout(20000),
        });
        const body = (await res.json()) as { cached?: boolean };
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (body.cached) cacheHits++;
        latencies.push(performance.now() - started);
      } catch {
        errors++;
      }
    }
  }

  const startedAll = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const elapsedSec = (performance.now() - startedAll) / 1000;

  const ok = latencies.length;
  latencies.sort((a, b) => a - b);

  console.log(`requests:      ${TOTAL} (concurrency ${CONCURRENCY})`);
  console.log(`succeeded:     ${ok}`);
  console.log(`errors:        ${errors}`);
  console.log(`p50:           ${percentile(latencies, 50).toFixed(1)} ms`);
  console.log(`p95:           ${percentile(latencies, 95).toFixed(1)} ms`);
  console.log(`p99:           ${percentile(latencies, 99).toFixed(1)} ms`);
  console.log(`cache hit rate: ${ok > 0 ? ((cacheHits / ok) * 100).toFixed(1) : "0.0"}%`);
  console.log(`requests/sec:  ${(ok / elapsedSec).toFixed(1)}`);

  if (errors > 0) process.exitCode = 1;
}

await main();
