/**
 * Latency benchmark for the local API: 30 distinct queries (cold), then the
 * same 30 again (warm), at concurrency 5. Prints cold p50/p95, warm p50 and
 * the average result count.
 *
 * Usage: node scripts/bench.ts
 * Env:   API_URL (default http://localhost:3000), CONCURRENCY (default 5),
 *        MAX_RESULTS (optional; omitted means the API default)
 */

const API_URL = process.env["API_URL"] ?? "http://localhost:3000";
const CONCURRENCY = Number(process.env["CONCURRENCY"] ?? 5);
const MAX_RESULTS = process.env["MAX_RESULTS"];

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
  "rust borrow checker",
  "typescript generics tutorial",
  "climate change effects",
  "best hiking trails in colorado",
  "how does tcp handshake work",
  "postgres vs mysql",
  "history of the roman empire",
  "react server components",
  "what is a black hole",
  "docker compose healthcheck",
  "machine learning basics",
  "how to learn guitar",
  "mediterranean diet benefits",
  "linux file permissions",
  "who invented the telephone",
  "electric car battery life",
  "git rebase vs merge",
  "solar system planets",
  "how to write a resume",
  "http caching headers",
];

interface Sample {
  ms: number;
  count: number;
  cached: boolean;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

async function runPhase(queries: string[]): Promise<{ samples: Sample[]; errors: number }> {
  const samples: Sample[] = [];
  let next = 0;
  let errors = 0;

  async function worker(): Promise<void> {
    while (true) {
      const q = queries[next++];
      if (q === undefined) return;
      const params = new URLSearchParams({ q });
      if (MAX_RESULTS) params.set("max_results", MAX_RESULTS);
      const started = performance.now();
      try {
        const res = await fetch(`${API_URL}/search?${params}`, {
          signal: AbortSignal.timeout(20000),
        });
        const body = (await res.json()) as { cached?: boolean; results?: unknown[] };
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        samples.push({
          ms: performance.now() - started,
          count: body.results?.length ?? 0,
          cached: body.cached === true,
        });
      } catch {
        errors++;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return { samples, errors };
}

function summarize(label: string, { samples, errors }: { samples: Sample[]; errors: number }) {
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  const avgCount = samples.reduce((n, s) => n + s.count, 0) / Math.max(1, samples.length);
  const hits = samples.filter((s) => s.cached).length;
  process.stdout.write(
    `${label}: ok=${samples.length} errors=${errors} p50=${percentile(sorted, 50).toFixed(1)}ms ` +
      `p95=${percentile(sorted, 95).toFixed(1)}ms avgResults=${avgCount.toFixed(1)} cacheHits=${hits}\n`,
  );
  return errors;
}

const cold = await runPhase(QUERIES);
const warm = await runPhase(QUERIES);
const errors = summarize("cold", cold) + summarize("warm", warm);
if (errors > 0) process.exitCode = 1;
