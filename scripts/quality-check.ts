/**
 * Runs a fixed set of queries against the local API and prints a quality table.
 * Exits non-zero if any result is on a blocked/adult domain.
 *
 * Usage: node scripts/quality-check.ts
 * Env:   API_URL (default http://localhost:3000), SEARXNG_URL (default http://localhost:8080),
 *        BLOCKED_DOMAINS (comma-separated, replaces the built-in list)
 */

const API_URL = process.env["API_URL"] ?? "http://localhost:3000";
const SEARXNG_URL = process.env["SEARXNG_URL"] ?? "http://localhost:8080";

const QUERIES = [
  // what is X
  "what is python",
  "what is kubernetes",
  "who is ada lovelace",
  "what is quantum computing",
  // news
  "latest technology news",
  "world news today",
  "stock market news",
  // how-to
  "how to install node.js",
  "how to center a div in css",
  "how to bake sourdough bread",
  // ambiguous
  "python",
  "jaguar",
  "java",
  "mercury",
  "apple",
];

const DEFAULT_BLOCKED = [
  "pornhub.com",
  "xvideos.com",
  "xnxx.com",
  "xhamster.com",
  "redtube.com",
  "youporn.com",
  "spankbang.com",
  "onlyfans.com",
  "stripchat.com",
  "chaturbate.com",
  "livejasmin.com",
  "brazzers.com",
  "eporner.com",
];

const blocked = (
  process.env["BLOCKED_DOMAINS"] !== undefined
    ? process.env["BLOCKED_DOMAINS"].split(",")
    : DEFAULT_BLOCKED
)
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

// Catches adult sites that are not on the explicit list.
const ADULT_HOST_HINT = /porn|xxx|(^|[.-])sex|nsfw|hentai|xvideo|camgirl/i;
const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;

interface ApiResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

interface ApiResponse {
  results: ApiResult[];
  partial: boolean;
  cached: boolean;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isBlockedHost(host: string): boolean {
  return blocked.some((d) => host === d || host.endsWith(`.${d}`)) || ADULT_HOST_HINT.test(host);
}

/** The API response omits engines, so ask SearXNG directly (same params the service sends). */
async function enginesUsed(query: string): Promise<string> {
  try {
    const params = new URLSearchParams({
      q: query,
      format: "json",
      language: "en-US",
      safesearch: "2",
      categories: "general",
    });
    const res = await fetch(`${SEARXNG_URL}/search?${params}`, {
      signal: AbortSignal.timeout(8000),
    });
    const data = (await res.json()) as { results?: { engine?: string; engines?: string[] }[] };
    const engines = new Set<string>();
    for (const r of data.results ?? []) {
      if (r.engine) engines.add(r.engine);
      for (const e of r.engines ?? []) engines.add(e);
    }
    return engines.size > 0 ? [...engines].sort().join(",") : "-";
  } catch {
    return "?";
  }
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width);
}

async function main(): Promise<void> {
  const rows: string[][] = [];
  const violations: string[] = [];
  let failedRequests = 0;

  for (const query of QUERIES) {
    const started = performance.now();
    let body: ApiResponse;
    try {
      const res = await fetch(`${API_URL}/search?${new URLSearchParams({ q: query })}`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = (await res.json()) as ApiResponse;
    } catch (err) {
      failedRequests++;
      rows.push([query, "ERR", "-", "-", "-", "-", err instanceof Error ? err.message : "error"]);
      continue;
    }
    const elapsedMs = Math.round(performance.now() - started);

    const results = body.results;
    const english = results.filter(
      (r) => !NON_LATIN_LETTER.test(r.title) && !NON_LATIN_LETTER.test(r.content),
    ).length;
    const pctEnglish = results.length > 0 ? Math.round((english / results.length) * 100) : 0;

    const hosts = results.map((r) => hostOf(r.url));
    const bad = [...new Set(hosts.filter(isBlockedHost))];
    for (const host of bad) violations.push(`${query}: ${host}`);

    const topDomains = [...new Set(hosts)].slice(0, 3).join(", ") || "-";
    const engines = await enginesUsed(query);

    rows.push([
      query,
      String(results.length),
      engines,
      results.length > 0 ? `${pctEnglish}%` : "-",
      bad.length > 0 ? bad.join(",") : "no",
      topDomains,
      `${elapsedMs}ms${body.cached ? " (c)" : ""}${body.partial ? " (p)" : ""}`,
    ]);
  }

  const headers = ["query", "results", "engines", "%en", "blocked", "top-3 domains", "time"];
  const widths = [30, 7, 28, 5, 14, 48, 12];
  console.log(headers.map((h, i) => pad(h, widths[i] ?? 10)).join(" | "));
  console.log(widths.map((w) => "-".repeat(w)).join("-+-"));
  for (const row of rows) {
    console.log(row.map((c, i) => pad(c, widths[i] ?? 10)).join(" | "));
  }
  console.log("\n(c) = served from cache, (p) = partial (some engines failed)");

  if (violations.length > 0) {
    console.error(`\nFAIL: ${violations.length} blocked/adult domain hit(s):`);
    for (const v of violations) console.error(`  ${v}`);
    process.exitCode = 1;
  } else if (failedRequests > 0) {
    console.error(`\nWARN: ${failedRequests} request(s) failed; blocklist check incomplete.`);
  } else {
    console.log("\nOK: no blocked or adult domains in any result.");
  }
}

await main();
